import { Inject, Injectable } from '@nestjs/common';
import { withContext } from '../../../observability/context';
import { inSpan } from '../../../observability/tracing';
import { type AppMetrics, METRICS } from '../../../shared/application/metrics';
import { CLOCK, type Clock } from '../../../shared/application/ports';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/application/unit-of-work';
import { WagerTransactionStatus } from '../domain/wager-transaction-kind';
import { WagerApplier } from './wager-applier';

export type PendingResolution = 'resolved' | 'still_pending' | 'skipped';

/**
 * Re-evaluates ONE PENDING_REFERENCE transaction. Safe with many workers in parallel:
 * the wallet lock serializes them, and the transaction is re-read UNDER the lock, so a
 * transaction already handled by another instance (or not due anymore) is skipped.
 */
@Injectable()
export class ResolvePendingReferenceUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: AppMetrics,
    private readonly applier: WagerApplier,
  ) {}

  resolve(transactionId: string): Promise<PendingResolution> {
    return withContext({ transactionId, correlationId: transactionId }, () =>
      inSpan(
        'pending_reference.resolve',
        { 'wagering.transaction_id': transactionId },
        async () => {
          const result = await this.resolveInTransaction(transactionId);
          this.metrics.pendingResolution(result);
          return result;
        },
      ),
    );
  }

  private resolveInTransaction(transactionId: string): Promise<PendingResolution> {
    return this.uow.run(async (repos) => {
      const candidate = await repos.wagers.findById(transactionId);
      if (candidate?.status !== WagerTransactionStatus.PendingReference) return 'skipped';

      const wallet = await repos.wallets.lockById(candidate.walletId);
      if (!wallet) return 'skipped'; // impossible: FK, kept for type narrowing

      const transaction = await repos.wagers.findById(transactionId);
      const due = transaction?.nextReferenceAttemptAt;
      if (
        transaction?.status !== WagerTransactionStatus.PendingReference ||
        (due !== undefined && due.getTime() > this.clock.now().getTime())
      ) {
        return 'skipped';
      }

      const outcome = await this.applier.apply(
        repos,
        transaction,
        wallet,
        { correlationId: transaction.id, causationId: `pending-reference:${transaction.id}` },
        'update',
      );
      return outcome.type === 'pending_reference' ? 'still_pending' : 'resolved';
    });
  }
}
