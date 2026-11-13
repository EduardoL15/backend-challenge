/**
 * Mandatory concurrency scenarios with REAL parallelism: three separate `bun src/main.ts`
 * processes (each with its own DB pool and SQS client, all roles enabled) sharing one
 * PostgreSQL and one LocalStack. Requests are spread across the processes.
 *
 *   1. the same bet sent 50 times in parallel -> one debit
 *   2. two simultaneous bets fighting for the same balance (section 8 scenario)
 *   3. distinct wallets processed in parallel
 *   4. >= 3 processes at once, HTTP and SQS mixed on a hot wallet
 *   6. concurrent outbox publishers (3 processes) -> every committed event published
 *   7. ROLLBACK delivered before its BET
 *  (5 and 8 - crashes and restarts - live in crash-recovery.test.ts)
 *
 * Every scenario ends with the global invariant: balance == ledger, for EVERY wallet.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ClusterClient,
  type Instance,
  inconsistentWallets,
  logsWhere,
  spawnInstance,
} from '../support/cluster';
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

let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;
let eventsQueueName: string;
let eventsQueueUrl: string;
let instances: Instance[] = [];
let client: ClusterClient;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  sqs = testSqsClient();
  queues = await createTestQueues(sqs, { maxReceiveCount: 5, visibilityTimeoutSeconds: 10 });
  eventsQueueName = `test-cluster-events-${uuid().slice(0, 8)}.fifo`;
  eventsQueueUrl =
    (
      await sqs.send(
        new CreateQueueCommand({ QueueName: eventsQueueName, Attributes: { FifoQueue: 'true' } }),
      )
    ).QueueUrl ?? '';

  const env = {
    SQS_WAGER_QUEUE_NAME: queues.mainName,
    SQS_WAGER_DLQ_NAME: queues.dlqName,
    SQS_EVENTS_QUEUE_NAME: eventsQueueName,
    SQS_CONSUMER_NAME: 'cluster-consumer',
  };
  instances = await Promise.all(
    [1, 2, 3].map((n) =>
      spawnInstance({
        name: `node-${String(n)}`,
        port: 3100 + n,
        roles: 'api,consumer,outbox,pending',
        env,
      }),
    ),
  );
  client = new ClusterClient(() => instances);
}, 60_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => i.kill()));
  await queues.destroy();
  await sqs.send(new DeleteQueueCommand({ QueueUrl: eventsQueueUrl }));
  sqs.destroy();
  await orm.close(true);
});

// ---------------------------------------------------------------- helpers

interface Wallet {
  id: string;
  playerId: string;
}

interface WagerResponse {
  transactionId: string;
  status: string;
  failureCode?: string;
  idempotentReplay: boolean;
}

async function createWallet(amount: string): Promise<Wallet> {
  const playerId = uuid();
  const res = await client.post<{ id: string }>('/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(res.status).toBe(201);
  return { id: res.body.id, playerId };
}

function wager(
  w: Wallet,
  input: { ext?: string; kind?: string; amount: string; ref?: string },
  target?: Instance,
) {
  const ext = input.ext ?? uuid();
  return client.post<WagerResponse>(
    '/wagering/transactions',
    {
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'g',
      kind: input.kind ?? 'BET',
      money: { amount: input.amount, currency: 'BRL' },
      ...(input.ref !== undefined ? { referenceExternalTransactionId: input.ref } : {}),
    },
    { 'Idempotency-Key': `provider-a:${ext}` },
    target,
  );
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  return (await query<{ n: number }>(orm, sql, params))[0]?.n ?? -1;
}

const debits = (walletId: string) =>
  scalar(
    `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
    [walletId],
  );

async function balance(walletId: string): Promise<string> {
  return (
    (
      await query<{ balance: string }>(orm, 'SELECT balance FROM wallets WHERE id = $1', [walletId])
    )[0]?.balance ?? 'missing'
  );
}

async function expectGlobalInvariant(): Promise<void> {
  expect(await inconsistentWallets(orm)).toEqual([]);
}

const servedBy = (results: { servedBy: string }[]) => new Set(results.map((r) => r.servedBy));

// ------------------------------------------------------------------- tests

describe('multi-instance concurrency (3 real processes)', () => {
  it('1. the same bet sent 50 times in parallel across 3 processes debits exactly once', async () => {
    const w = await createWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => wager(w, { ext: 'same-bet', amount: '10.00' })),
    );
    expect(servedBy(results).size).toBe(3); // really spread over the 3 processes
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await debits(w.id)).toBe(1);
    expect(await balance(w.id)).toBe('90.00');
    await expectGlobalInvariant();
  }, 60_000);

  it('2. 100.00 and two simultaneous 80.00 bets on DIFFERENT processes (x10 wallets)', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet('100.00')));
    const [a, b] = instances;
    if (!a || !b) throw new Error('instances missing');
    const pairs = await Promise.all(
      wallets.map((w) =>
        Promise.all([wager(w, { amount: '80.00' }, a), wager(w, { amount: '80.00' }, b)]),
      ),
    );
    for (const [i, pair] of pairs.entries()) {
      const w = wallets[i];
      if (!w) continue;
      const statuses = pair.map((r) => r.body.status).sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      expect(pair.find((r) => r.body.status === 'REJECTED')?.body.failureCode).toBe(
        'INSUFFICIENT_FUNDS',
      );
      expect(await balance(w.id)).toBe('20.00');
      expect(await debits(w.id)).toBe(1);
    }
    await expectGlobalInvariant();
  }, 60_000);

  it('3. distinct wallets are processed in parallel, independently and exactly', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet('50.00')));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 10 }, () => wager(w, { amount: '2.50' }))),
    );
    for (const w of wallets) {
      expect(await balance(w.id)).toBe('25.00');
      expect(await debits(w.id)).toBe(10);
    }
    await expectGlobalInvariant();
  }, 90_000);

  it('4. hot wallet hit by 3 processes at once through HTTP AND SQS never overdraws', async () => {
    const w = await createWallet('50.00');
    const viaSqs = Array.from({ length: 30 }, () =>
      wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '1.00' }),
    );
    // Spread over 6 message groups so the 3 consumers really compete for the same wallet.
    const sends = viaSqs.map((e, i) =>
      sendRaw(sqs, queues.mainUrl, JSON.stringify(e), `hot-${String(i % 6)}`),
    );
    const http = Array.from({ length: 30 }, () => wager(w, { amount: '1.00' }));
    const [httpResults] = await Promise.all([Promise.all(http), Promise.all(sends)]);
    await waitFor(async () => (await queueDepth(sqs, queues.mainUrl)) === 0, {
      what: 'queue drained',
      timeoutMs: 60_000,
    });

    const processed = await scalar(
      `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'`,
      [w.id],
    );
    const rejected = await scalar(
      `SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET' AND status = 'REJECTED'`,
      [w.id],
    );
    expect(processed).toBe(50);
    expect(rejected).toBe(10);
    expect(await balance(w.id)).toBe('0.00');
    expect(servedBy(httpResults).size).toBe(3);
    const consumersThatWorked = instances.filter(
      (i) => logsWhere(i, (l) => l.msg === 'Message handled' && l.walletId === w.id).length > 0,
    );
    expect(consumersThatWorked.length).toBeGreaterThan(1);
    await expectGlobalInvariant();
  }, 120_000);

  it('7. ROLLBACK delivered before its BET (via SQS and via HTTP on different processes)', async () => {
    // SQS: same message group => FIFO delivers ROLLBACK first, then BET.
    const viaQueue = await createWallet('100.00');
    const rollback = wagerEnvelope({
      walletId: viaQueue.id,
      playerId: viaQueue.playerId,
      kind: 'ROLLBACK',
      amount: '40.00',
      externalId: 'q-rollback',
      ref: 'q-bet',
    });
    const bet = wagerEnvelope({
      walletId: viaQueue.id,
      playerId: viaQueue.playerId,
      amount: '40.00',
      externalId: 'q-bet',
    });
    await sendRaw(sqs, queues.mainUrl, JSON.stringify(rollback), viaQueue.id);
    await sendRaw(sqs, queues.mainUrl, JSON.stringify(bet), viaQueue.id);

    // HTTP: ROLLBACK to node-1, BET to node-2, the pending worker of any node may finish it.
    const viaHttp = await createWallet('100.00');
    const [n1, n2] = instances;
    const first = await wager(
      viaHttp,
      { kind: 'ROLLBACK', ext: 'h-rollback', ref: 'h-bet', amount: '25.00' },
      n1,
    );
    expect(first.status).toBe(202);
    expect((await wager(viaHttp, { ext: 'h-bet', amount: '25.00' }, n2)).status).toBe(201);

    for (const w of [viaQueue, viaHttp]) {
      await waitFor(
        async () =>
          (await scalar(
            `SELECT count(*)::int AS n FROM wager_transactions
              WHERE wallet_id = $1 AND kind = 'ROLLBACK' AND status = 'PROCESSED'`,
            [w.id],
          )) === 1,
        { what: 'rollback resolved', timeoutMs: 20_000 },
      );
      expect(await balance(w.id)).toBe('100.00');
    }
    await expectGlobalInvariant();
  }, 60_000);

  it('6. three concurrent outbox publishers deliver every committed event (none lost)', async () => {
    await waitFor(
      async () =>
        (await scalar(
          'SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL',
        )) === 0,
      { what: 'outbox drained by the 3 publishers', timeoutMs: 60_000 },
    );
    const committed = await query<{ id: string }>(orm, 'SELECT id FROM outbox_messages');
    const received = new Set<string>();
    for (;;) {
      const batch = await drain(sqs, eventsQueueUrl);
      if (batch.length === 0) break;
      for (const m of batch) {
        const id = m.MessageAttributes?.eventId?.StringValue;
        if (id) received.add(id);
        // FIFO: a group with an un-deleted (in-flight) message delivers nothing more.
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: eventsQueueUrl, ReceiptHandle: m.ReceiptHandle }),
        );
      }
    }
    expect(committed.length).toBeGreaterThan(500);
    expect(received.size).toBe(committed.length);
    expect(committed.every((e) => received.has(e.id))).toBe(true);
    await expectGlobalInvariant();
  }, 120_000);
});
