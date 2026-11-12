import { Inject, Injectable, Logger } from '@nestjs/common';
import { addContext } from '../../../observability/context';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed';
import type { Wallet } from '../../wallet/domain/wallet';
import { eventContextFactory } from '../../../shared/application/event-context';
import {
  CLOCK,
  type Clock,
  type ExecutionContext,
  ID_GENERATOR,
  type IdGenerator,
} from '../../../shared/application/ports';
import type { TransactionalRepositories } from '../../../shared/application/unit-of-work';
import { type BackoffOptions, nextAttemptAt } from '../../../shared/domain/backoff';
import type { EventContext, IntegrationEvent } from '../../../shared/domain/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wagering-events';
import type { WagerTransaction } from '../domain/wager-transaction';
import { type WagerOutcome, applyWagerTransaction } from '../domain/wagering-policy';

export interface WageringSettings {
  maxReferenceAttempts: number;
  referenceBackoff: BackoffOptions;
}
export const WAGERING_SETTINGS = Symbol('WageringSettings');

/**
 * Shared by the intake flow (HTTP/SQS) and the PENDING_REFERENCE worker, so both apply
 * EXACTLY the same rules. Must run inside a UnitOfWork, with the wallet already locked.
 */
@Injectable()
export class WagerApplier {
  private readonly logger = new Logger('WagerApplier');

  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WAGERING_SETTINGS) private readonly settings: WageringSettings,
  ) {}

  async apply(
    repos: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: ExecutionContext,
    persistence: 'insert' | 'update',
  ): Promise<WagerOutcome> {
    const now = this.clock.now();
    const reference =
      transaction.referenceExternalTransactionId !== undefined
        ? await repos.wagers.findByProviderAndExternalId(
            transaction.providerId,
            transaction.referenceExternalTransactionId,
          )
        : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && transaction.isReversal()
        ? await repos.wagers.hasProcessedReversal(reference.id)
        : false;

    const outcome = applyWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      entryId: this.ids.next(),
      at: now,
      maxReferenceAttempts: this.settings.maxReferenceAttempts,
      scheduleReferenceRetry: (attempt, at) =>
        nextAttemptAt(at, attempt, this.settings.referenceBackoff),
    });

    addContext({ transactionId: transaction.id, walletId: wallet.id });
    // Decision log: identifiers and outcome only (amounts/balances stay out of the logs).
    this.logger.log({
      msg: 'Wager transaction applied',
      kind: transaction.kind,
      status: transaction.status,
      ...(transaction.failureCode !== undefined ? { failureCode: transaction.failureCode } : {}),
      ...(outcome.type === 'pending_reference'
        ? { referenceAttempts: transaction.referenceAttempts }
        : {}),
    });

    if (persistence === 'insert') repos.wagers.add(transaction);
    else await repos.wagers.save(transaction);

    if (outcome.type === 'processed' && outcome.entry) {
      repos.ledger.append(outcome.entry);
      await repos.wallets.save(wallet);
    }

    const newEventContext = eventContextFactory(this.ids, this.clock, ctx);
    for (const event of eventsFor(outcome, transaction, wallet, newEventContext)) {
      repos.outbox.add(OutboxMessage.enqueue(event));
    }

    // This transaction reached a final state: wake up whoever on this wallet was waiting
    // for it as a reference, instead of letting them sleep until their next backoff slot.
    if (outcome.type !== 'pending_reference') {
      await repos.wagers.wakePendingReferencing(
        wallet.id,
        transaction.providerId,
        transaction.externalTransactionId,
        now,
      );
    }
    return outcome;
  }
}

function eventsFor(
  outcome: WagerOutcome,
  transaction: WagerTransaction,
  wallet: Wallet,
  newContext: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (outcome.type) {
    case 'processed':
      return [
        WagerTransactionProcessed.from(transaction, newContext()),
        ...(outcome.entry ? [WalletBalanceChanged.from(wallet, outcome.entry, newContext())] : []),
      ];
    case 'rejected':
      return [WagerTransactionRejected.from(transaction, newContext())];
    case 'pending_reference':
      // Announced once, when it first starts waiting; retries that keep waiting are silent.
      return transaction.referenceAttempts === 1
        ? [WagerTransactionPendingReference.from(transaction, newContext())]
        : [];
  }
}
