/**
 * Domain <-> mapper <-> MikroORM <-> PostgreSQL round trips, using the same write path the
 * use cases will use: one em.transactional() with a pessimistic lock on the wallet row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/shared/domain/money';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { InboxMessage } from '../../src/modules/messaging/domain/inbox-message';
import {
  InboxMessageRecord,
  OutboxMessageRecord,
} from '../../src/modules/messaging/infra/persistence/messaging.schema';
import {
  InboxMessageMapper,
  OutboxMessageMapper,
} from '../../src/modules/messaging/infra/persistence/messaging.mapper';
import { WalletBalanceChanged } from '../../src/modules/wallet/domain/events/wallet-balance-changed';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import {
  LedgerEntryRecord,
  WalletRecord,
} from '../../src/modules/wallet/infra/persistence/wallet.schema';
import {
  LedgerEntryMapper,
  WalletMapper,
} from '../../src/modules/wallet/infra/persistence/wallet.mapper';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/wager-transaction-kind';
import { applyWagerTransaction } from '../../src/modules/wagering/domain/wagering-policy';
import { WagerTransactionRecord } from '../../src/modules/wagering/infra/persistence/wager-transaction.schema';
import { WagerTransactionMapper } from '../../src/modules/wagering/infra/persistence/wager-transaction.mapper';
import { FailureCode } from '../../src/shared/domain/failure-code';
import { createTestOrm, query, resetSchema, uuid } from '../support/db';

let orm: MikroORM;
const AT = new Date('2026-07-29T15:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
});

afterAll(async () => {
  await orm.close(true);
});

async function openWallet(initial: string): Promise<Wallet> {
  const walletId = uuid();
  const playerId = uuid();
  const opening = WagerTransaction.createOpening({
    id: uuid(),
    walletId,
    playerId,
    money: brl(initial),
    at: AT,
  });
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(initial),
    openingTransactionId: opening.id,
    openingEntryId: uuid(),
    at: AT,
  });
  opening.markProcessed(undefined, AT, wallet.balance);

  await orm.em.fork().transactional(async (em) => {
    em.create(WalletRecord, WalletMapper.toRecord(wallet));
    if (openingEntry) {
      em.create(WagerTransactionRecord, WagerTransactionMapper.toRecord(opening));
      em.create(LedgerEntryRecord, LedgerEntryMapper.toRecord(openingEntry));
    }
    await em.flush();
  });
  return wallet;
}

/** The write path of a wager use case, minus idempotency (phase 4). */
async function placeBet(
  walletId: string,
  playerId: string,
  amount: string,
  options: { crashBeforeCommit?: boolean } = {},
) {
  return orm.em.fork().transactional(async (em: EntityManager) => {
    const walletRecord = await em.findOneOrFail(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    const wallet = WalletMapper.toDomain(walletRecord);
    const externalId = uuid();
    const tx = WagerTransaction.create({
      id: uuid(),
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      payloadHash: 'hash',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl(amount),
      at: AT,
    });
    const outcome = applyWagerTransaction({
      transaction: tx,
      wallet,
      reference: undefined,
      referenceAlreadyReversed: false,
      entryId: uuid(),
      at: AT,
      maxReferenceAttempts: 8,
      scheduleReferenceRetry: () => AT,
    });

    em.create(WagerTransactionRecord, WagerTransactionMapper.toRecord(tx));
    if (outcome.type === 'processed' && outcome.entry) {
      em.assign(walletRecord, WalletMapper.toRecord(wallet));
      em.create(LedgerEntryRecord, LedgerEntryMapper.toRecord(outcome.entry));
      const event = WalletBalanceChanged.from(wallet, outcome.entry, {
        eventId: uuid(),
        correlationId: 'corr',
        occurredAt: AT,
      });
      em.create(OutboxMessageRecord, OutboxMessageMapper.toRecord(OutboxMessage.enqueue(event)));
    }
    await em.flush();
    if (options.crashBeforeCommit) throw new Error('simulated crash before commit');
    return { tx, outcome };
  });
}

async function ledgerBalance(walletId: string): Promise<string> {
  const [row] = await query<{ total: string }>(
    orm,
    `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS total
       FROM wallet_ledger_entries WHERE wallet_id = $1`,
    [walletId],
  );
  return row?.total ?? 'missing';
}

describe('persistence round trip', () => {
  it('reads money back as exact decimal strings, never numbers', async () => {
    const wallet = await openWallet('1000.10');
    const record = await orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id });
    expect(typeof record.balance).toBe('string');
    expect(record.balance).toBe('1000.10');
    expect(record.createdAt).toEqual(AT);
    const restored = WalletMapper.toDomain(record);
    expect(restored.balance.equals(wallet.balance)).toBe(true);
    expect(restored.version).toBe(1);
  });

  it('wager transaction survives a full round trip', async () => {
    const wallet = await openWallet('100.00');
    const { tx } = await placeBet(wallet.id, wallet.playerId, '25.00');
    const record = await orm.em.fork().findOneOrFail(WagerTransactionRecord, { id: tx.id });
    const restored = WagerTransactionMapper.toDomain(record);
    expect(restored.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.money.amount).toBe('25.00');
    expect(restored.resultBalance?.amount).toBe('75.00');
    expect(restored.processedAt).toEqual(AT);
    expect(restored.referenceExternalTransactionId).toBeUndefined();
  });

  it('ledger entries come back with seq (cursor) and balanced', async () => {
    const wallet = await openWallet('100.00');
    await placeBet(wallet.id, wallet.playerId, '10.00');
    const records = await orm.em
      .fork()
      .find(LedgerEntryRecord, { walletId: wallet.id }, { orderBy: { walletVersion: 'asc' } });
    expect(records).toHaveLength(2);
    expect(records.every((r) => typeof r.seq === 'string' && /^\d+$/.test(r.seq))).toBe(true);
    const entries = records.map((r) => LedgerEntryMapper.toDomain(r));
    expect(entries.map((e) => e.isBalanced())).toEqual([true, true]);
    expect(entries.map((e) => e.balanceAfter.amount)).toEqual(['100.00', '90.00']);
  });

  it('outbox payload (jsonb) and inbox round trip', async () => {
    const wallet = await openWallet('100.00');
    await placeBet(wallet.id, wallet.playerId, '10.00');
    const [outbox] = await orm.em.fork().find(OutboxMessageRecord, { aggregateId: wallet.id });
    expect(outbox).toBeDefined();
    const message = OutboxMessageMapper.toDomain(outbox as OutboxMessageRecord);
    expect(message.isPending()).toBe(true);
    expect(message.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      data: { balanceAfter: { amount: '90.00', currency: 'BRL' }, walletVersion: 2 },
    });

    const inbox = InboxMessage.receive({
      messageId: uuid(),
      consumerName: 'wager-consumer',
      payloadHash: 'h',
      at: AT,
    });
    await orm.em.fork().transactional(async (em) => {
      em.create(InboxMessageRecord, InboxMessageMapper.toRecord(inbox));
      await em.flush();
    });
    const back = await orm.em.fork().findOneOrFail(InboxMessageRecord, {
      consumerName: 'wager-consumer',
      messageId: inbox.messageId,
    });
    expect(InboxMessageMapper.toDomain(back).isProcessed()).toBe(false);
  });
});

describe('atomicity', () => {
  it('a rejected BET persists the transaction but no ledger entry, outbox or balance change', async () => {
    const wallet = await openWallet('10.00');
    const { tx, outcome } = await placeBet(wallet.id, wallet.playerId, '50.00');
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    const [row] = await query<{ status: string; failure_code: string }>(
      orm,
      'SELECT status, failure_code FROM wager_transactions WHERE id = $1',
      [tx.id],
    );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await ledgerBalance(wallet.id)).toBe('10.00');
  });

  it('a crash before COMMIT leaves no trace: wallet, transaction, ledger and outbox roll back together', async () => {
    const wallet = await openWallet('100.00');
    try {
      await placeBet(wallet.id, wallet.playerId, '30.00', { crashBeforeCommit: true });
    } catch {
      // expected
    }
    const counts = await query<{ txs: string; entries: string; outbox: string }>(
      orm,
      `SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET')::text AS txs,
              (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = $1)::text AS entries,
              (SELECT count(*) FROM outbox_messages WHERE aggregate_id = $1::text)::text AS outbox`,
      [wallet.id],
    );
    expect(counts[0]).toEqual({ txs: '0', entries: '1', outbox: '0' });
    const record = await orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id });
    expect(record.balance).toBe('100.00');
    expect(record.version).toBe(1);
  });

  it('sequential bets keep wallet.balance == SUM(ledger)', async () => {
    const wallet = await openWallet('100.00');
    for (const amount of ['10.00', '20.00', '0.01', '80.00', '69.99']) {
      await placeBet(wallet.id, wallet.playerId, amount);
    }
    const record = await orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id });
    expect(record.balance).toBe('0.00');
    expect(await ledgerBalance(wallet.id)).toBe(record.balance);
    // 80.00 was rejected (only 69.99 left at that point), so 4 debits + opening
    expect(record.version).toBe(5);
  });
});
