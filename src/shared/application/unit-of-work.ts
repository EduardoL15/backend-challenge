import type { InboxMessage } from '../../modules/messaging/domain/inbox-message';
import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';
import type { WagerTransaction } from '../../modules/wagering/domain/wager-transaction';
import type { Wallet } from '../../modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../modules/wallet/domain/wallet-ledger-entry';

export interface WalletRepository {
  /** SELECT ... FOR UPDATE: serializes every financial operation on this wallet. */
  lockById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  save(wallet: Wallet): Promise<void>;
}

export interface LedgerRepository {
  /** Append-only: there is deliberately no update/delete. */
  append(entry: WalletLedgerEntry): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  /**
   * Makes PENDING_REFERENCE transactions of this wallet that wait for
   * (providerId, externalTransactionId) due right now.
   */
  wakePendingReferencing(
    walletId: string,
    providerId: string,
    externalTransactionId: string,
    at: Date,
  ): Promise<void>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** True when a PROCESSED REFUND or ROLLBACK already references this transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}

export interface InboxRepository {
  /** Inserts the message; returns false if (consumer, messageId) was already there. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  save(message: InboxMessage): Promise<void>;
}

/** Repositories bound to ONE SQL transaction. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  wagers: WagerTransactionRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/**
 * Transaction boundary. Everything done through `repos` inside `work` is committed together
 * or not at all (wallet, ledger, transaction, inbox, outbox). Database failures are translated
 * into UniqueViolationError / TransientInfrastructureError.
 */
export interface UnitOfWork {
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
