/**
 * Crash scenarios with REAL processes, killed with SIGKILL (no graceful shutdown at all):
 *
 *   5. a consumer dies AFTER the SQL commit and BEFORE acknowledging the message
 *   8. instances are killed in the middle of a mixed HTTP + SQS workload and restarted;
 *      the final state is proven consistent and complete (nothing lost, nothing doubled)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
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
  queueDepth,
  sendRaw,
  testSqsClient,
  type TestQueues,
  waitFor,
  wagerEnvelope,
} from '../support/sqs';

const CONSUMER = 'crash-consumer';

let orm: MikroORM;
let sqs: SQSClient;
let queues: TestQueues;
let running: Instance[] = [];

function env(): Record<string, string> {
  return {
    SQS_WAGER_QUEUE_NAME: queues.mainName,
    SQS_WAGER_DLQ_NAME: queues.dlqName,
    SQS_CONSUMER_NAME: CONSUMER,
  };
}

async function start(
  name: string,
  port: number,
  roles: string,
  extra: Record<string, string> = {},
) {
  const instance = await spawnInstance({ name, port, roles, env: { ...env(), ...extra } });
  running.push(instance);
  return instance;
}

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  sqs = testSqsClient();
  // Short visibility timeout: a message whose consumer died reappears after 3s.
  queues = await createTestQueues(sqs, { maxReceiveCount: 10, visibilityTimeoutSeconds: 3 });
});

afterEach(async () => {
  await Promise.all(running.map((i) => i.kill()));
  running = [];
});

afterAll(async () => {
  await queues.destroy();
  sqs.destroy();
  await orm.close(true);
});

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  return (await query<{ n: number }>(orm, sql, params))[0]?.n ?? -1;
}

async function balance(walletId: string): Promise<string> {
  return (
    (
      await query<{ balance: string }>(orm, 'SELECT balance FROM wallets WHERE id = $1', [walletId])
    )[0]?.balance ?? 'missing'
  );
}

async function createWallet(client: ClusterClient, amount: string) {
  const playerId = uuid();
  const res = await client.post<{ id: string }>('/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  return { id: res.body.id, playerId };
}

describe('crash recovery (real processes, SIGKILL)', () => {
  it('5. consumer killed after COMMIT and before ACK: redelivered, recognised, not re-applied', async () => {
    const api = await start('api-node', 3201, 'api');
    const client = new ClusterClient(() => [api]);
    const w = await createWallet(client, '100.00');

    const envelope = wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '30.00' });
    const doomed = await start('doomed-consumer', 3202, 'consumer', {
      FAULT_CRASH_AFTER_COMMIT_MESSAGE_ID: envelope.messageId,
    });
    await sendRaw(sqs, queues.mainUrl, JSON.stringify(envelope), w.id);

    // The process kills itself right after the commit.
    await waitFor(
      () => Promise.resolve(doomed.process.signalCode !== null || doomed.process.exitCode !== null),
      {
        what: 'consumer death',
        timeoutMs: 20_000,
      },
    );
    expect(logsWhere(doomed, (l) => String(l.msg).startsWith('FAULT INJECTION')).length).toBe(1);

    // Effects ARE committed...
    expect(await balance(w.id)).toBe('70.00');
    expect(
      await scalar('SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = $1', [
        envelope.messageId,
      ]),
    ).toBe(1);
    // ...but the message was NOT acknowledged: it is still in the queue.
    expect(await queueDepth(sqs, queues.mainUrl)).toBe(1);

    // Another consumer takes over once the visibility timeout expires.
    const survivor = await start('survivor-consumer', 3203, 'consumer');
    await waitFor(async () => (await queueDepth(sqs, queues.mainUrl)) === 0, {
      what: 'redelivery acknowledged',
      timeoutMs: 20_000,
    });
    const handled = logsWhere(
      survivor,
      (l) => l.msg === 'Message handled' && l.messageId === envelope.messageId,
    );
    expect(handled.map((l) => l.outcome)).toEqual(['duplicate']); // recognised by the inbox
    expect(await balance(w.id)).toBe('70.00'); // debited once
    expect(
      await scalar(
        `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
        [w.id],
      ),
    ).toBe(1);
    expect(await inconsistentWallets(orm)).toEqual([]);
  }, 60_000);

  it('8. instances killed mid-workload and restarted: final state complete and consistent', async () => {
    const nodes = await Promise.all(
      [1, 2, 3].map((n) => start(`node-${String(n)}`, 3210 + n, 'api,consumer,outbox,pending')),
    );
    const client = new ClusterClient(() => running);
    const wallets = await Promise.all(
      Array.from({ length: 8 }, () => createWallet(client, '1000.00')),
    );

    // Deterministic workload (no rejections possible) so the expected end state is known:
    // per wallet 15 BETs of 1.00 via SQS, 10 BETs of 2.00 via HTTP, and one ROLLBACK of a
    // 50.00 BET that is delivered BEFORE the BET itself.
    const messages = wallets.flatMap((w) =>
      Array.from({ length: 15 }, () =>
        wagerEnvelope({ walletId: w.id, playerId: w.playerId, amount: '1.00' }),
      ),
    );
    const rollbacks = wallets.flatMap((w, i) => [
      wagerEnvelope({
        walletId: w.id,
        playerId: w.playerId,
        kind: 'ROLLBACK',
        amount: '50.00',
        externalId: `rb-${String(i)}`,
        ref: `big-${String(i)}`,
      }),
      wagerEnvelope({
        walletId: w.id,
        playerId: w.playerId,
        amount: '50.00',
        externalId: `big-${String(i)}`,
      }),
    ]);
    const allMessages = [...messages, ...rollbacks];

    const sendAll = (async () => {
      for (const [i, m] of allMessages.entries()) {
        await sendRaw(
          sqs,
          queues.mainUrl,
          JSON.stringify(m),
          `${m.data.walletId}-${String(i % 3)}`,
        );
      }
    })();
    const http = Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 10 }, async () => {
          const ext = uuid();
          return client.post(
            '/wagering/transactions',
            {
              providerId: 'provider-a',
              externalTransactionId: ext,
              playerId: w.playerId,
              walletId: w.id,
              roundId: 'r',
              gameId: 'g',
              kind: 'BET',
              money: { amount: '2.00', currency: 'BRL' },
            },
            { 'Idempotency-Key': `provider-a:${ext}` },
          );
        }),
      ),
    );

    // Kill two of the three processes in the middle of the storm, then bring them back.
    await waitFor(
      async () => (await scalar('SELECT count(*)::int AS n FROM inbox_messages')) >= 20,
      { what: 'workload under way', timeoutMs: 30_000, intervalMs: 50 },
    );
    const [, n2, n3] = nodes;
    await Promise.all([n2?.kill('SIGKILL'), n3?.kill('SIGKILL')]);
    const processedAtKill = await scalar('SELECT count(*)::int AS n FROM inbox_messages');
    running = running.filter((i) => i !== n2 && i !== n3);
    await Bun.sleep(1_000);
    await start('node-2b', 3222, 'api,consumer,outbox,pending');
    await start('node-3b', 3223, 'api,consumer,outbox,pending');

    const httpResults = await http;
    await sendAll;
    expect(httpResults.every((r) => r.status === 201 || r.status === 200)).toBe(true);

    // Everything settles: queue empty, outbox drained, nothing left waiting for a reference.
    await waitFor(
      async () =>
        (await queueDepth(sqs, queues.mainUrl)) === 0 &&
        (await scalar(
          'SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL',
        )) === 0 &&
        (await scalar(
          `SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
        )) === 0,
      { what: 'system settled after restarts', timeoutMs: 90_000, intervalMs: 500 },
    );

    // Nothing lost: every message has its inbox row.
    // (only THIS scenario's messages: scenario 5 shares the consumer name)
    const inboxed = await scalar(
      `SELECT count(*)::int AS n FROM inbox_messages
        WHERE consumer_name = $1 AND message_id IN ($2)`,
      [CONSUMER, allMessages.map((m) => m.messageId)],
    );
    expect(inboxed).toBe(allMessages.length);
    // The kill really happened mid-stream: work was still pending when the processes died.
    expect(processedAtKill).toBeLessThan(allMessages.length);
    // Nothing doubled, exact final balances: 1000 - 15*1 - 10*2 - 50 + 50 = 965.
    for (const w of wallets) {
      expect(await balance(w.id)).toBe('965.00');
      expect(
        await scalar(
          `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
          [w.id],
        ),
      ).toBe(15 + 10 + 1);
    }
    expect(
      await scalar(`SELECT count(*)::int AS n FROM wager_transactions WHERE status <> 'PROCESSED'`),
    ).toBe(0);
    expect(await inconsistentWallets(orm)).toEqual([]);
    // Reconciliation through the API agrees for every wallet.
    for (const w of wallets) {
      const rec = await client.post<{ consistent: boolean }>(`/wallets/${w.id}/reconciliation`, {});
      expect(rec.body.consistent).toBe(true);
    }
  }, 180_000);
});
