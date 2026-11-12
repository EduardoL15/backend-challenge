/**
 * SQS consumer against real LocalStack + PostgreSQL. Each file gets its own FIFO queue + DLQ.
 * Broker-side deduplication is deliberately bypassed (fresh MessageDeduplicationId on every
 * send): duplicates must be stopped by the persistent inbox, not by SQS FIFO.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { messageHash } from '../../src/modules/wagering/infra/sqs/wager-message';
import { wagerMessageSchema } from '../../src/modules/wagering/application/wager-contract';
import { api, startTestApp, type TestApp } from '../support/app';
import { createTestOrm, query, resetSchema, uuid } from '../support/db';
import {
  createTestQueues,
  drain,
  queueDepth,
  sendRaw,
  testSqsClient,
  type TestQueues,
  waitFor,
  wagerEnvelope,
} from '../support/sqs';

const CONSUMER = 'test-consumer';
const MAX_RECEIVES = 3;

let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;
let app: TestApp | undefined;

function appEnv(): Record<string, string> {
  return {
    APP_ROLES: 'api,consumer',
    SQS_WAGER_QUEUE_NAME: queues.mainName,
    SQS_WAGER_DLQ_NAME: queues.dlqName,
    SQS_CONSUMER_NAME: CONSUMER,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_MAX_RECEIVE_COUNT: String(MAX_RECEIVES),
    SQS_RETRY_BASE_SECONDS: '1',
    SQS_RETRY_MAX_SECONDS: '2',
    DB_LOCK_TIMEOUT_MS: '300',
    SHUTDOWN_GRACE_MS: '10000',
    AWS_ENDPOINT_URL: 'http://localhost:4566',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  };
}

async function startApp(): Promise<TestApp> {
  app = await startTestApp(appEnv());
  return app;
}

async function stopApp(): Promise<void> {
  await app?.close();
  app = undefined;
}

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, {
    maxReceiveCount: MAX_RECEIVES,
    visibilityTimeoutSeconds: 5,
  });
  await startApp();
});

afterAll(async () => {
  await stopApp();
  await queues.destroy();
  sqs.destroy();
  await orm.close(true);
});

// ---------------------------------------------------------------- helpers

interface Wallet {
  id: string;
  playerId: string;
}

async function createWallet(amount = '100.00'): Promise<Wallet> {
  if (!app) throw new Error('app not started');
  const playerId = uuid();
  const res = await api<{ id: string }>(app.baseUrl, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount, currency: 'BRL' } },
  });
  return { id: res.body.id, playerId };
}

const send = (envelope: unknown, groupId: string) =>
  sendRaw(sqs, queues.mainUrl, JSON.stringify(envelope), groupId);

async function scalar(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{ n: number }>(orm, sql, params);
  return rows[0]?.n ?? -1;
}

const debits = (walletId: string) =>
  scalar(
    `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
    [walletId],
  );

const inboxRows = (messageId: string) =>
  scalar(
    `SELECT count(*)::int AS n FROM inbox_messages
      WHERE consumer_name = $1 AND message_id = $2 AND processed_at IS NOT NULL`,
    [CONSUMER, messageId],
  );

async function balance(walletId: string): Promise<string> {
  const rows = await query<{ balance: string }>(orm, 'SELECT balance FROM wallets WHERE id = $1', [
    walletId,
  ]);
  return rows[0]?.balance ?? 'missing';
}

async function assertConsistent(walletId: string): Promise<void> {
  const rows = await query<{ ok: boolean }>(
    orm,
    `SELECT w.balance = COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS ok
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = $1 GROUP BY w.id`,
    [walletId],
  );
  expect(rows[0]?.ok).toBe(true);
}

const queueEmpty = async () => (await queueDepth(sqs, queues.mainUrl)) === 0;

/** Holds the wallet row lock in another transaction, simulating a stuck competitor. */
function holdWalletLock(walletId: string, ms: number): { released: Promise<void> } {
  const released = orm.em.fork().transactional(async (em) => {
    await em.execute('SELECT 1 FROM wallets WHERE id = ? FOR UPDATE', [walletId]);
    await new Promise((r) => setTimeout(r, ms));
  });
  return { released };
}

// ------------------------------------------------------------------- tests

describe('SQS consumer', () => {
  it('processes a message, records the inbox in the same transaction and acks it', async () => {
    const w = await createWallet('100.00');
    const envelope = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '25.00' });
    await send(envelope, w.id);
    await waitFor(async () => (await inboxRows(envelope.messageId)) === 1, { what: 'inbox row' });
    await waitFor(queueEmpty, { what: 'ack' });
    expect(await balance(w.id)).toBe('75.00');
    await assertConsistent(w.id);
  }, 30_000);

  it('the same message delivered twice (broker dedup bypassed) is applied once', async () => {
    const w = await createWallet('100.00');
    const envelope = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '10.00' });
    await send(envelope, w.id);
    await send(envelope, w.id);
    await waitFor(queueEmpty, { what: 'both deliveries acked' });
    expect(await inboxRows(envelope.messageId)).toBe(1);
    expect(await debits(w.id)).toBe(1);
    expect(await balance(w.id)).toBe('90.00');
  }, 30_000);

  it('a different messageId for the same operation is an idempotent replay (one debit)', async () => {
    const w = await createWallet('100.00');
    const a = wagerEnvelope({ walletId: w.id, playerId: w.playerId, externalId: 'same-op' });
    const b = { ...a, messageId: `msg-${uuid()}` };
    await send(a, w.id);
    await send(b, w.id);
    await waitFor(queueEmpty, { what: 'acks' });
    expect(await inboxRows(a.messageId)).toBe(1);
    expect(await inboxRows(b.messageId)).toBe(1);
    expect(await debits(w.id)).toBe(1);
  }, 30_000);

  it('a business rejection is terminal: acked, not retried, not dead-lettered', async () => {
    const w = await createWallet('5.00');
    const envelope = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '50.00' });
    await send(envelope, w.id);
    await waitFor(async () => (await inboxRows(envelope.messageId)) === 1, { what: 'inbox' });
    await waitFor(queueEmpty, { what: 'ack' });
    const [tx] = await query<{ status: string; failure_code: string }>(
      orm,
      'SELECT status, failure_code FROM wager_transactions WHERE wallet_id = $1 AND kind = $2',
      [w.id, 'BET'],
    );
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await drain(sqs, queues.dlqUrl)).toHaveLength(0);
  }, 30_000);

  it('unknown wallet is a business error: acked without side effects', async () => {
    const envelope = wagerEnvelope({ walletId: uuid(), playerId: uuid() });
    await send(envelope, 'unknown-wallet');
    await waitFor(queueEmpty, { what: 'ack' });
    expect(await inboxRows(envelope.messageId)).toBe(0); // rolled back with the failed attempt
    expect(await drain(sqs, queues.dlqUrl)).toHaveLength(0);
  }, 30_000);

  it.each([
    ['malformed JSON', '{not json', 'MALFORMED_JSON'],
    ['invalid envelope', JSON.stringify({ messageId: 'x', type: 'Other' }), 'INVALID_ENVELOPE'],
  ])(
    '%s goes straight to the DLQ (permanent)',
    async (_label, body, reason) => {
      await sendRaw(sqs, queues.mainUrl, body, `poison-${uuid()}`);
      await waitFor(queueEmpty, { what: 'removal from main queue' });
      const parked = await drain(sqs, queues.dlqUrl);
      expect(parked).toHaveLength(1);
      expect(parked[0]?.Body).toBe(body);
      expect(parked[0]?.MessageAttributes?.dlqReason?.StringValue).toBe(reason);
    },
    30_000,
  );

  it('an invalid amount (contract error) is permanent: DLQ, wallet untouched', async () => {
    const w = await createWallet('100.00');
    const envelope = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '1.005' });
    await send(envelope, w.id);
    await waitFor(queueEmpty, { what: 'removal' });
    const parked = await drain(sqs, queues.dlqUrl);
    expect(parked[0]?.MessageAttributes?.dlqReason?.StringValue).toBe('INVALID_AMOUNT');
    expect(await balance(w.id)).toBe('100.00');
  }, 30_000);

  it('transient failure (lock timeout) is retried with backoff and then succeeds', async () => {
    const w = await createWallet('100.00');
    const lock = holdWalletLock(w.id, 2_500);
    const envelope = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '10.00' });
    await send(envelope, w.id);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await inboxRows(envelope.messageId)).toBe(0); // still blocked, nothing applied
    await lock.released;
    await waitFor(async () => (await inboxRows(envelope.messageId)) === 1, {
      what: 'processing after the lock is released',
      timeoutMs: 15_000,
    });
    expect(await debits(w.id)).toBe(1);
    expect(await drain(sqs, queues.dlqUrl)).toHaveLength(0);
  }, 30_000);

  it('a transient failure that never clears ends in the DLQ via redrive (maxReceiveCount)', async () => {
    const w = await createWallet('100.00');
    const lock = holdWalletLock(w.id, 14_000);
    const envelope = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '10.00' });
    await send(envelope, w.id);
    let parked: Awaited<ReturnType<typeof drain>> = [];
    await waitFor(
      async () => {
        parked = await drain(sqs, queues.dlqUrl);
        return parked.length > 0;
      },
      { what: 'redrive to DLQ', timeoutMs: 13_000, intervalMs: 500 },
    );
    expect(JSON.parse(parked[0]?.Body ?? '{}')).toMatchObject({ messageId: envelope.messageId });
    await lock.released;
    expect(await debits(w.id)).toBe(0);
    expect(await balance(w.id)).toBe('100.00');
  }, 40_000);

  it('worker died after COMMIT but before ACK: the redelivery is recognised, no double debit', async () => {
    if (!app) throw new Error('app not started');
    const w = await createWallet('100.00');
    const envelope = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '30.00' });
    const parsed = wagerMessageSchema.parse(envelope);
    // A previous worker processed and committed the message, then died before DeleteMessage.
    await app.app
      .get(ProcessWagerTransactionUseCase)
      .executeFromMessage(
        parsed.data,
        { correlationId: parsed.messageId, causationId: parsed.messageId },
        { consumerName: CONSUMER, messageId: parsed.messageId, payloadHash: messageHash(parsed) },
      );
    expect(await balance(w.id)).toBe('70.00');
    // ...so SQS redelivers it.
    await send(envelope, w.id);
    await waitFor(queueEmpty, { what: 'ack of the redelivery' });
    expect(await debits(w.id)).toBe(1);
    expect(await balance(w.id)).toBe('70.00');
  }, 30_000);

  it('same messageId with a different body is a poison message (DLQ)', async () => {
    const w = await createWallet('100.00');
    const original = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '10.00' });
    await send(original, w.id);
    await waitFor(async () => (await inboxRows(original.messageId)) === 1, { what: 'inbox' });
    const tampered = {
      ...original,
      data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } },
    };
    await send(tampered, w.id);
    await waitFor(queueEmpty, { what: 'removal' });
    const parked = await drain(sqs, queues.dlqUrl);
    expect(parked[0]?.MessageAttributes?.dlqReason?.StringValue).toBe('INBOX_PAYLOAD_MISMATCH');
    expect(await balance(w.id)).toBe('90.00');
  }, 30_000);

  it('SIGTERM mid-stream loses nothing: restart finishes the rest exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet('100.00')));
    const envelopes = wallets.flatMap((w) =>
      Array.from({ length: 5 }, () =>
        wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '1.00' }),
      ),
    );
    await Promise.all(envelopes.map((e) => send(e, e.data.walletId)));

    // Shut down while messages are being processed.
    await waitFor(
      async () =>
        (await scalar(`SELECT count(*)::int AS n FROM inbox_messages WHERE consumer_name = $1`, [
          CONSUMER,
        ])) > 0,
      { what: 'first messages processed', intervalMs: 20 },
    );
    await stopApp();
    const processedBeforeRestart = (
      await Promise.all(envelopes.map((e) => inboxRows(e.messageId)))
    ).filter((n) => n === 1).length;

    await startApp();
    await waitFor(
      async () =>
        (await Promise.all(envelopes.map((e) => inboxRows(e.messageId)))).every((n) => n === 1),
      { what: 'all 30 messages processed after restart', timeoutMs: 30_000 },
    );
    await waitFor(queueEmpty, { what: 'queue drained' });
    for (const w of wallets) {
      expect(await debits(w.id)).toBe(5);
      expect(await balance(w.id)).toBe('95.00');
      await assertConsistent(w.id);
    }
    // The shutdown really happened mid-stream: the restarted instance had work left.
    expect(processedBeforeRestart).toBeLessThan(envelopes.length);
  }, 60_000);
});
