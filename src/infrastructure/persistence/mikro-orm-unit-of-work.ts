import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../../modules/messaging/domain/inbox-message';
import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';
import {
  InboxMessageMapper,
  OutboxMessageMapper,
} from '../../modules/messaging/infra/persistence/messaging.mapper';
import {
  InboxMessageRecord,
  OutboxMessageRecord,
} from '../../modules/messaging/infra/persistence/messaging.schema';
import type { WagerTransaction } from '../../modules/wagering/domain/wager-transaction';
import { WagerTransactionMapper } from '../../modules/wagering/infra/persistence/wager-transaction.mapper';
import { WagerTransactionRecord } from '../../modules/wagering/infra/persistence/wager-transaction.schema';
import type { Wallet } from '../../modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../modules/wallet/domain/wallet-ledger-entry';
import {
  LedgerEntryMapper,
  WalletMapper,
} from '../../modules/wallet/infra/persistence/wallet.mapper';
import {
  LedgerEntryRecord,
  WalletRecord,
} from '../../modules/wallet/infra/persistence/wallet.schema';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionalRepositories,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../shared/application/unit-of-work';
import { type AppMetrics, NoopMetrics } from '../../shared/application/metrics';
import { lockFailureKind, translateDbError } from './db-errors';

export interface UnitOfWorkOptions {
  /** How long to wait for a wallet row lock before failing with a transient error. */
  lockTimeoutMs: number;
}

/**
 * One SQL transaction per run(), on a forked EntityManager (no shared identity map between
 * requests). READ COMMITTED is enough: every financial decision is taken while holding the
 * wallet row lock, and the schema re-checks the invariants at COMMIT.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
    private readonly metrics: AppMetrics = new NoopMetrics(),
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // SET LOCAL: scoped to this transaction only. Integer, so no injection risk.
        await em.execute(
          `SET LOCAL lock_timeout = ${String(Math.trunc(this.options.lockTimeoutMs))}`,
        );
        return work(repositoriesFor(em));
      });
    } catch (error) {
      const lockFailure = lockFailureKind(error);
      if (lockFailure) this.metrics.lockConflict(lockFailure);
      throw translateDbError(error);
    }
  }
}

export function repositoriesFor(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    wagers: new MikroOrmWagerTransactionRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  add(wallet: Wallet): void {
    this.em.create(WalletRecord, WalletMapper.toRecord(wallet));
  }

  async save(wallet: Wallet): Promise<void> {
    // Already in the identity map after lockById: no extra query.
    const record = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    this.em.assign(record, WalletMapper.toRecord(wallet));
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): void {
    this.em.create(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id }, { refresh: true });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async wakePendingReferencing(
    walletId: string,
    providerId: string,
    externalTransactionId: string,
    at: Date,
  ): Promise<void> {
    await this.em.execute(
      `UPDATE wager_transactions
          SET next_reference_attempt_at = ?, updated_at = ?
        WHERE status = 'PENDING_REFERENCE'
          AND wallet_id = ?
          AND provider_id = ?
          AND reference_external_transaction_id = ?
          AND next_reference_attempt_at > ?`,
      [at, at, walletId, providerId, externalTransactionId, at],
      'run',
    );
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    // refresh: always read the committed row, even if an earlier lookup cached a miss/hit.
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { idempotencyKey: key },
      { refresh: true },
    );
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      { refresh: true },
    );
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  add(transaction: WagerTransaction): void {
    this.em.create(WagerTransactionRecord, WagerTransactionMapper.toRecord(transaction));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, { id: transaction.id });
    this.em.assign(record, WagerTransactionMapper.toRecord(transaction));
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.create(OutboxMessageRecord, OutboxMessageMapper.toRecord(message));
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    // ON CONFLICT DO NOTHING: a concurrent consumer holding the same message makes us wait
    // for its COMMIT/ROLLBACK, then we see the row (duplicate) or insert it ourselves.
    const result = await this.em.execute<{ affectedRows: number }>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
      'run',
    );
    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(
      InboxMessageRecord,
      { consumerName, messageId },
      { refresh: true },
    );
    return record ? InboxMessageMapper.toDomain(record) : undefined;
  }

  async save(message: InboxMessage): Promise<void> {
    const record = await this.em.findOneOrFail(InboxMessageRecord, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    this.em.assign(record, InboxMessageMapper.toRecord(message));
  }
}
