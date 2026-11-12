import { Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCodes, NotFoundError, ValidationError } from '../../../shared/application/errors';
import type { MoneyProps } from '../../../shared/domain/money';
import type { Wallet } from '../domain/wallet';
import { type LedgerPage, WALLET_QUERIES, type WalletQueries } from './wallet-queries';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Hook for the divergence metric (wired to Prometheus in the observability phase). */
export interface ReconciliationMetrics {
  recordReconciliation(consistent: boolean): void;
}
export const RECONCILIATION_METRICS = Symbol('ReconciliationMetrics');

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 200;

@Injectable()
export class WalletReadUseCases {
  private readonly logger = new Logger('Reconciliation');

  constructor(
    @Inject(WALLET_QUERIES) private readonly queries: WalletQueries,
    @Inject(RECONCILIATION_METRICS) private readonly metrics: ReconciliationMetrics,
  ) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.queries.findWallet(walletId);
    if (!wallet) throw walletNotFound(walletId);
    return wallet;
  }

  async getLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    page: LedgerPage;
    nextCursor: string | undefined;
  }> {
    await this.getWallet(walletId);
    const afterSeq = cursor !== undefined ? decodeCursor(cursor) : undefined;
    const page = await this.queries.ledgerPage(walletId, afterSeq, limit);
    const last = page.items.at(-1);
    return { page, nextCursor: page.hasMore && last ? encodeCursor(last.seq) : undefined };
  }

  /**
   * Compares the materialized balance with the balance rebuilt from the ledger.
   * Divergences are NEVER corrected here: logged, counted in a metric and flagged.
   */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.queries.reconciliationSnapshot(walletId);
    if (!snapshot) throw walletNotFound(walletId);

    const { storedBalance, calculatedBalance, checkedEntries } = snapshot;
    const difference = storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();
    this.metrics.recordReconciliation(consistent);
    if (!consistent) {
      this.logger.error({
        msg: 'Wallet balance diverges from ledger',
        walletId,
        storedBalance: storedBalance.amount,
        calculatedBalance: calculatedBalance.amount,
        difference: difference.amount,
        checkedEntries,
      });
    }
    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries,
    };
  }
}

function walletNotFound(walletId: string): NotFoundError {
  return new NotFoundError(ErrorCodes.WalletNotFound, `Wallet ${walletId} not found`);
}

/** Opaque cursor: base64url("v1:<seq>"). Stable because seq is an immutable identity. */
export function encodeCursor(seq: string): string {
  return Buffer.from(`v1:${seq}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^v1:(\d{1,19})$/.exec(decoded);
  if (!match?.[1]) {
    throw new ValidationError('Invalid cursor', [{ path: 'cursor', message: 'malformed cursor' }]);
  }
  return match[1];
}
