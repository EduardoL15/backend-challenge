/**
 * PENDING_REFERENCE flow: dependent operations that arrive before their reference.
 * The backoff is deliberately LONG (30s): fast resolution in these tests can only come from
 * the wake-up done when the reference arrives, or from explicit "time travel" in the DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { api, startTestApp, type TestApp } from '../support/app';
import { createTestOrm, query, resetSchema, uuid } from '../support/db';
import { waitFor } from '../support/sqs';

const MAX_ATTEMPTS = 3;
const settings = {
  PENDING_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_BASE_MS: '30000',
  PENDING_REFERENCE_MAX_MS: '30000',
  PENDING_REFERENCE_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
};

let orm: MikroORM;
let main: TestApp;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  main = await startTestApp({ APP_ROLES: 'api,pending', ...settings });
});

afterAll(async () => {
  await main.close();
  await orm.close(true);
});

// ---------------------------------------------------------------- helpers

interface Wallet {
  id: string;
  playerId: string;
}

interface Result {
  transactionId: string;
  status: string;
  failureCode?: string;
  idempotentReplay: boolean;
}

async function createWallet(amount = '100.00', base = main.baseUrl): Promise<Wallet> {
  const playerId = uuid();
  const res = await api<{ id: string }>(base, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount, currency: 'BRL' } },
  });
  return { id: res.body.id, playerId };
}

function submit(w: Wallet, kind: string, externalId: string, amount: string, ref?: string) {
  return api<Result>(main.baseUrl, 'POST', '/wagering/transactions', {
    headers: { 'Idempotency-Key': `provider-a:${externalId}` },
    body: {
      providerId: 'provider-a',
      externalTransactionId: externalId,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'g',
      kind,
      money: { amount, currency: 'BRL' },
      ...(ref !== undefined ? { referenceExternalTransactionId: ref } : {}),
    },
  });
}

async function txRow(id: string) {
  const rows = await query<{
    status: string;
    failure_code: string | null;
    reference_attempts: number;
    reference_transaction_id: string | null;
  }>(
    orm,
    'SELECT status, failure_code, reference_attempts, reference_transaction_id FROM wager_transactions WHERE id = $1',
    [id],
  );
  return rows[0];
}

const balance = async (walletId: string) =>
  (
    await query<{ balance: string }>(orm, 'SELECT balance FROM wallets WHERE id = $1', [walletId])
  )[0]?.balance;

async function consistent(walletId: string): Promise<boolean> {
  const rows = await query<{ ok: boolean }>(
    orm,
    `SELECT w.balance = COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS ok
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = $1 GROUP BY w.id`,
    [walletId],
  );
  return rows[0]?.ok === true;
}

/** Time travel: make a pending transaction due now (allowed: not a business column). */
const makeDue = (id: string) =>
  query(orm, 'UPDATE wager_transactions SET next_reference_attempt_at = now() WHERE id = $1', [id]);

async function outboxTypesFor(transactionId: string): Promise<string[]> {
  const rows = await query<{ event_type: string }>(
    orm,
    'SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY occurred_at',
    [transactionId],
  );
  return rows.map((r) => r.event_type);
}

// ------------------------------------------------------------------- tests

describe('PENDING_REFERENCE', () => {
  it('ROLLBACK delivered before its BET is applied as soon as the BET arrives (wake-up)', async () => {
    const w = await createWallet('100.00');
    const rollback = await submit(w, 'ROLLBACK', 'rb-1', '30.00', 'bet-1');
    expect(rollback.status).toBe(202);
    expect(rollback.body.status).toBe('PENDING_REFERENCE');

    const bet = await submit(w, 'BET', 'bet-1', '30.00');
    expect(bet.status).toBe(201);
    expect(await balance(w.id)).toBe('70.00');

    // Backoff is 30s: resolving within a few seconds proves the wake-up path.
    await waitFor(async () => (await txRow(rollback.body.transactionId))?.status === 'PROCESSED', {
      what: 'rollback resolved',
      timeoutMs: 5_000,
    });
    const row = await txRow(rollback.body.transactionId);
    expect(row?.reference_transaction_id).toBe(bet.body.transactionId);
    expect(await balance(w.id)).toBe('100.00');
    expect(await consistent(w.id)).toBe(true);

    // The provider retrying the original request now sees the final result.
    const replay = await submit(w, 'ROLLBACK', 'rb-1', '30.00', 'bet-1');
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    expect(await outboxTypesFor(rollback.body.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
  }, 20_000);

  it('a reference that never arrives ends REJECTED with REFERENCE_NOT_FOUND after the attempt limit', async () => {
    const w = await createWallet('100.00');
    const refund = await submit(w, 'REFUND', 'rf-ghost', '10.00', 'ghost-bet');
    const id = refund.body.transactionId;
    expect((await txRow(id))?.reference_attempts).toBe(1);

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await makeDue(id);
      await waitFor(async () => (await txRow(id))?.reference_attempts === attempt, {
        what: `attempt ${String(attempt)}`,
        timeoutMs: 5_000,
      });
      expect((await txRow(id))?.status).toBe('PENDING_REFERENCE');
    }

    await makeDue(id);
    await waitFor(async () => (await txRow(id))?.status === 'REJECTED', {
      what: 'final rejection',
      timeoutMs: 5_000,
    });
    expect((await txRow(id))?.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(await balance(w.id)).toBe('100.00');
    // Announced once when it started waiting, once when it was rejected; retries are silent.
    expect(await outboxTypesFor(id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  }, 30_000);

  it('a REFUND waiting for a BET that gets REJECTED is rejected as REFERENCE_NOT_PROCESSED', async () => {
    const w = await createWallet('5.00');
    const refund = await submit(w, 'REFUND', 'rf-2', '50.00', 'bet-2');
    expect(refund.body.status).toBe('PENDING_REFERENCE');
    const bet = await submit(w, 'BET', 'bet-2', '50.00');
    expect(bet.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    await waitFor(async () => (await txRow(refund.body.transactionId))?.status === 'REJECTED', {
      what: 'refund rejected',
      timeoutMs: 5_000,
    });
    expect((await txRow(refund.body.transactionId))?.failure_code).toBe('REFERENCE_NOT_PROCESSED');
    expect(await balance(w.id)).toBe('5.00');
  }, 20_000);

  it('several worker instances resolve each pending transaction exactly once', async () => {
    const extra = await startTestApp({ APP_ROLES: 'pending', ...settings });
    try {
      const wallets = await Promise.all(Array.from({ length: 15 }, () => createWallet('100.00')));
      const rollbacks = await Promise.all(
        wallets.map((w, i) =>
          submit(w, 'ROLLBACK', `rb-m-${String(i)}`, '10.00', `bet-m-${String(i)}`),
        ),
      );
      // The BETs arrive: each one wakes its waiting ROLLBACK (due now), and both worker
      // instances poll every 100ms and race for the same 15 due transactions.
      await Promise.all(wallets.map((w, i) => submit(w, 'BET', `bet-m-${String(i)}`, '10.00')));

      await waitFor(
        async () =>
          (await Promise.all(rollbacks.map((r) => txRow(r.body.transactionId)))).every(
            (row) => row?.status === 'PROCESSED',
          ),
        { what: 'all rollbacks resolved', timeoutMs: 15_000 },
      );
      for (const w of wallets) {
        expect(await balance(w.id)).toBe('100.00');
        expect(await consistent(w.id)).toBe(true);
      }
      const credits = await query<{ n: number }>(
        orm,
        `SELECT count(*)::int AS n FROM wallet_ledger_entries l
           JOIN wager_transactions t ON t.id = l.transaction_id
          WHERE t.kind = 'ROLLBACK' AND t.external_transaction_id LIKE 'rb-m-%'`,
      );
      expect(credits[0]?.n).toBe(15);
    } finally {
      await extra.close();
    }
  }, 40_000);
});
