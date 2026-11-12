/**
 * The real HTTP API (AppModule) against a real PostgreSQL. Every test ends by checking
 * the global invariant: wallet.balance == balance rebuilt from the ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { api, startTestApp, type TestApp } from '../support/app';
import { createTestOrm, query, resetSchema, uuid } from '../support/db';

let testApp: TestApp;
let orm: MikroORM;
let base: string;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  testApp = await startTestApp();
  base = testApp.baseUrl;
});

afterAll(async () => {
  await testApp.close();
  await orm.close(true);
});

// ---------------------------------------------------------------- helpers

interface Wallet {
  id: string;
  playerId: string;
}

async function createWallet(amount = '100.00', currency = 'BRL'): Promise<Wallet> {
  const playerId = uuid();
  const res = await api<{ id: string }>(base, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount, currency } },
  });
  expect(res.status).toBe(201);
  return { id: res.body.id, playerId };
}

interface WagerInput {
  kind?: string;
  amount?: string;
  currency?: string;
  externalId?: string;
  key?: string;
  ref?: string;
  roundId?: string;
  providerId?: string;
}

function wagerBody(w: Wallet, input: WagerInput = {}) {
  return {
    providerId: input.providerId ?? 'provider-a',
    externalTransactionId: input.externalId ?? uuid(),
    playerId: w.playerId,
    walletId: w.id,
    roundId: input.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: input.kind ?? 'BET',
    money: { amount: input.amount ?? '10.00', currency: input.currency ?? 'BRL' },
    ...(input.ref !== undefined ? { referenceExternalTransactionId: input.ref } : {}),
  };
}

interface WagerResponse {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
  failureCode?: string;
  error?: { code: string; retryable: boolean };
}

async function submit(w: Wallet, input: WagerInput = {}) {
  const body = wagerBody(w, input);
  const key = input.key ?? `${body.providerId}:${body.externalTransactionId}`;
  return api<WagerResponse>(base, 'POST', '/wagering/transactions', {
    body,
    headers: { 'Idempotency-Key': key },
  });
}

async function assertLedgerInvariant(walletId: string): Promise<void> {
  const res = await api<{
    consistent: boolean;
    storedBalance: unknown;
    calculatedBalance: unknown;
  }>(base, 'POST', `/wallets/${walletId}/reconciliation`);
  expect(res.status).toBe(200);
  expect(res.body.consistent).toBe(true);
  expect(res.body.storedBalance).toEqual(res.body.calculatedBalance);
}

async function balanceOf(walletId: string): Promise<string> {
  const res = await api<{ balance: { amount: string } }>(base, 'GET', `/wallets/${walletId}`);
  return res.body.balance.amount;
}

async function debitCount(walletId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    orm,
    `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
    [walletId],
  );
  return rows[0]?.n ?? -1;
}

// ------------------------------------------------------------------ wallets

describe('POST /wallets', () => {
  it('creates a wallet with an OPENING credit in the same transaction', async () => {
    const playerId = uuid();
    const res = await api(base, 'POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const ledger = await api<{ items: { direction: string; money: unknown }[] }>(
      base,
      'GET',
      `/wallets/${String(res.body.id)}/ledger`,
    );
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
    });
    await assertLedgerInvariant(String(res.body.id));
  });

  it('zero initial balance creates no ledger entry', async () => {
    const w = await createWallet('0.00');
    const ledger = await api<{ items: unknown[] }>(base, 'GET', `/wallets/${w.id}/ledger`);
    expect(ledger.body.items).toHaveLength(0);
    await assertLedgerInvariant(w.id);
  });

  it('a duplicate player + currency is a 409 conflict, even when created concurrently', async () => {
    const playerId = uuid();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api(base, 'POST', '/wallets', {
          body: { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } },
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
  });

  it.each([
    [{ playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } }],
    [{ playerId: uuid(), initialBalance: { amount: 10, currency: 'BRL' } }],
    [{ playerId: uuid(), initialBalance: { amount: '1.001', currency: 'BRL' } }],
    [{ playerId: uuid(), initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    [{ playerId: uuid(), initialBalance: { amount: '1.00', currency: 'brl' } }],
    [{ playerId: uuid() }],
  ])('invalid payload -> 400 (%#)', async (body) => {
    const res = await api<{ error: { code: string } }>(base, 'POST', '/wallets', { body });
    expect(res.status).toBe(400);
    expect(['INVALID_PAYLOAD', 'INVALID_AMOUNT']).toContain(res.body.error.code);
  });
});

// -------------------------------------------------------------- wager flow

describe('POST /wagering/transactions', () => {
  it('BET processed: 201 with the new balance', async () => {
    const w = await createWallet('1000.00');
    const res = await submit(w, { amount: '25.00' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    await assertLedgerInvariant(w.id);
  });

  it('identical replay: 200, same body, idempotentReplay=true, original balance', async () => {
    const w = await createWallet('100.00');
    const first = await submit(w, { externalId: 'bet-1', amount: '30.00' });
    await submit(w, { amount: '10.00' }); // balance moves on afterwards
    const replay = await submit(w, { externalId: 'bet-1', amount: '30.00' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance?.amount).toBe('70.00'); // observed at the time, not now (60.00)
    expect(await debitCount(w.id)).toBe(2);
  });

  it('same key with a different payload: 409, not a replay', async () => {
    const w = await createWallet('100.00');
    await submit(w, { externalId: 'bet-x', amount: '10.00' });
    const conflict = await submit(w, { externalId: 'bet-x', amount: '11.00' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
    expect(await balanceOf(w.id)).toBe('90.00');
  });

  it('same externalTransactionId with another Idempotency-Key: 409', async () => {
    const w = await createWallet('100.00');
    await submit(w, { externalId: 'bet-y', key: 'key-1' });
    const res = await submit(w, { externalId: 'bet-y', key: 'key-2' });
    expect(res.status).toBe(409);
  });

  it('insufficient funds: 422 REJECTED, replay keeps 422, nothing debited', async () => {
    const w = await createWallet('10.00');
    const res = await submit(w, { externalId: 'big-bet', amount: '10.01' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    const replay = await submit(w, { externalId: 'big-bet', amount: '10.01' });
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(await debitCount(w.id)).toBe(0);
    await assertLedgerInvariant(w.id);
  });

  it('WIN credits, LOSS does not move the balance', async () => {
    const w = await createWallet('100.00');
    await submit(w, { externalId: 'b', amount: '10.00' });
    expect((await submit(w, { kind: 'WIN', amount: '50.00', ref: 'b' })).status).toBe(201);
    const loss = await submit(w, { kind: 'LOSS', amount: '0.00' });
    expect(loss.status).toBe(201);
    expect(loss.body.balance?.amount).toBe('140.00');
    await assertLedgerInvariant(w.id);
  });

  it('REFUND reverses a BET once; a second reversal is rejected', async () => {
    const w = await createWallet('100.00');
    await submit(w, { externalId: 'bet-r', amount: '40.00' });
    const refund = await submit(w, { kind: 'REFUND', amount: '40.00', ref: 'bet-r' });
    expect(refund.status).toBe(201);
    expect(refund.body.balance?.amount).toBe('100.00');
    const rollback = await submit(w, { kind: 'ROLLBACK', amount: '40.00', ref: 'bet-r' });
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    await assertLedgerInvariant(w.id);
  });

  it('reversal that would go negative: REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const w = await createWallet('0.00');
    await submit(w, { kind: 'WIN', externalId: 'win-1', amount: '50.00' });
    await submit(w, { amount: '45.00' });
    const res = await submit(w, { kind: 'ROLLBACK', amount: '50.00', ref: 'win-1' });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    await assertLedgerInvariant(w.id);
  });

  it('reference not arrived yet: 202 PENDING_REFERENCE without touching the balance', async () => {
    const w = await createWallet('100.00');
    const res = await submit(w, { kind: 'ROLLBACK', amount: '10.00', ref: 'not-yet' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
    expect(await balanceOf(w.id)).toBe('100.00');
  });

  it('currency different from the wallet: 422 CURRENCY_MISMATCH', async () => {
    const w = await createWallet('100.00');
    const res = await submit(w, { currency: 'USD' });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
    // the snapshot stores the WALLET balance/currency
    expect(res.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('unknown wallet: 404', async () => {
    const res = await submit({ id: uuid(), playerId: uuid() });
    expect(res.status).toBe(404);
  });

  it.each([
    ['OPENING is internal', { kind: 'OPENING' }, 'INTERNAL_KIND_NOT_ALLOWED'],
    ['amount with 3 decimals', { amount: '1.005' }, 'INVALID_AMOUNT'],
    ['REFUND without reference', { kind: 'REFUND' }, 'INVALID_PAYLOAD'],
    ['unknown kind', { kind: 'JACKPOT' }, 'INVALID_PAYLOAD'],
  ])('%s -> 400 %s', async (_label, input, code) => {
    const w = await createWallet('100.00');
    const res = await submit(w, input);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe(code);
  });

  it('missing Idempotency-Key, malformed JSON and unknown fields -> 400', async () => {
    const w = await createWallet('100.00');
    const noKey = await api(base, 'POST', '/wagering/transactions', { body: wagerBody(w) });
    expect(noKey.status).toBe(400);
    const badJson = await api(base, 'POST', '/wagering/transactions', {
      rawBody: '{bad',
      headers: { 'Idempotency-Key': 'k' },
    });
    expect(badJson.status).toBe(400);
    const extra = await api(base, 'POST', '/wagering/transactions', {
      body: { ...wagerBody(w), hacker: true },
      headers: { 'Idempotency-Key': 'k2' },
    });
    expect(extra.status).toBe(400);
  });
});

// ---------------------------------------------------------------- queries

describe('queries', () => {
  it('GET transaction by id and by provider + external id', async () => {
    const w = await createWallet('100.00');
    const created = await submit(w, { externalId: 'q-1', amount: '5.00' });
    const byId = await api(base, 'GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ externalTransactionId: 'q-1', status: 'PROCESSED' });
    const byExt = await api(base, 'GET', '/providers/provider-a/wagering/transactions/q-1');
    expect(byExt.body.transactionId).toBe(created.body.transactionId);
    expect((await api(base, 'GET', `/wagering/transactions/${uuid()}`)).status).toBe(404);
    expect((await api(base, 'GET', '/wagering/transactions/not-a-uuid')).status).toBe(400);
  });

  it('ledger pagination: stable opaque cursor, no gaps, no duplicates', async () => {
    const w = await createWallet('100.00');
    for (let i = 0; i < 6; i++) await submit(w, { amount: '1.00' });
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `?limit=3&cursor=${cursor}` : '?limit=3';
      const page = await api<{ items: { walletVersion: number }[]; nextCursor: string | null }>(
        base,
        'GET',
        `/wallets/${w.id}/ledger${qs}`,
      );
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i) => i.walletVersion));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const bad = await api(base, 'GET', `/wallets/${w.id}/ledger?cursor=garbage`);
    expect(bad.status).toBe(400);
  });

  it('reconciliation flags (does not fix) a divergence', async () => {
    const w = await createWallet('100.00');
    // Simulate corruption bypassing every guard (superuser only, test-only).
    await orm.em.fork().transactional(async (em) => {
      await em.execute(`SET LOCAL session_replication_role = replica`);
      await em.execute(`UPDATE wallets SET balance = 90 WHERE id = ?`, [w.id]);
    });
    const res = await api(base, 'POST', `/wallets/${w.id}/reconciliation`);
    expect(res.body).toMatchObject({
      consistent: false,
      storedBalance: { amount: '90.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '-10.00' },
      checkedEntries: 1,
    });
    expect(await balanceOf(w.id)).toBe('90.00'); // not silently corrected
  });

  it('echoes or creates X-Correlation-Id', async () => {
    const res = await api(base, 'GET', '/health/live', {
      headers: { 'X-Correlation-Id': 'abc-123' },
    });
    expect(res.headers.get('x-correlation-id')).toBe('abc-123');
    const generated = await api(base, 'GET', '/health/live');
    expect(generated.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ----------------------------------------------------- concurrency (in-process)

describe('concurrency through the API', () => {
  it('mandatory scenario: 100.00 and two simultaneous 80.00 bets', async () => {
    const w = await createWallet('100.00');
    const results = await Promise.all([
      submit(w, { amount: '80.00' }),
      submit(w, { amount: '80.00' }),
    ]);
    const statuses = results.map((r) => r.body.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = results.find((r) => r.body.status === 'REJECTED');
    expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(w.id)).toBe('20.00');
    expect(await debitCount(w.id)).toBe(1);
    await assertLedgerInvariant(w.id);
  });

  it('the same bet sent 50 times in parallel debits exactly once', async () => {
    const w = await createWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(w, { externalId: 'same-bet', amount: '10.00' })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await debitCount(w.id)).toBe(1);
    expect(await balanceOf(w.id)).toBe('90.00');
    await assertLedgerInvariant(w.id);
  });

  it('20 different bets racing for one hot wallet never overdraw it', async () => {
    const w = await createWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => submit(w, { amount: '7.00' })),
    );
    const processed = results.filter((r) => r.body.status === 'PROCESSED').length;
    expect(processed).toBe(14); // 14 * 7 = 98
    expect(results.filter((r) => r.body.status === 'REJECTED')).toHaveLength(6);
    expect(await balanceOf(w.id)).toBe('2.00');
    await assertLedgerInvariant(w.id);
  });

  it('distinct wallets are processed in parallel independently', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet('50.00')));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 5 }, () => submit(w, { amount: '10.00' }))),
    );
    for (const w of wallets) {
      expect(await balanceOf(w.id)).toBe('0.00');
      await assertLedgerInvariant(w.id);
    }
  });
});
