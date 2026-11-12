import type { Money } from '../../../shared/domain/money';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface LedgerPageItem {
  entry: WalletLedgerEntry;
  /** Monotonic database sequence: the basis of the stable cursor. */
  seq: string;
}

export interface LedgerPage {
  items: LedgerPageItem[];
  hasMore: boolean;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

/** Read side: no locks, one statement per query (consistent snapshot per statement). */
export interface WalletQueries {
  findWallet(walletId: string): Promise<Wallet | undefined>;
  ledgerPage(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage>;
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export const WALLET_QUERIES = Symbol('WalletQueries');
