/**
 * Load test: `bun run test:load` against a RUNNING stack (default: the Compose stack with
 * 3 replicas behind nginx on :3000). See load-test/README.md for methodology.
 *
 * Experiments
 *   A. HTTP, closed loop: VUS virtual users for DURATION seconds. Mix: BET/WIN/LOSS on random
 *      wallets, HOT_RATIO of the traffic on ONE hot wallet (contention), REPLAY_RATIO of exact
 *      resends (idempotent replays).
 *   B. Queue: SQS_MESSAGES messages pushed to wager-transactions.fifo as fast as possible;
 *      measures drain throughput and end-to-end latency (send -> inbox commit).
 * Throughout: outbox backlog/lag sampled every second from the database.
 * Afterwards: server metric deltas (summed over replicas) and a correctness check under load.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { type LatencyStats, latencyStats, parsePrometheus, pick, round, sumSeries } from './lib';

// ------------------------------------------------------------------ config

const cfg = {
  baseUrl: process.env.LOAD_BASE_URL ?? 'http://localhost:3000',
  databaseUrl:
    process.env.LOAD_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering',
  sqsEndpoint: process.env.LOAD_SQS_ENDPOINT ?? 'http://localhost:4566',
  queueName: process.env.LOAD_QUEUE_NAME ?? 'wager-transactions.fifo',
  durationS: Number(process.env.LOAD_DURATION_S ?? 30),
  vus: Number(process.env.LOAD_VUS ?? 32),
  wallets: Number(process.env.LOAD_WALLETS ?? 100),
  hotRatio: Number(process.env.LOAD_HOT_RATIO ?? 0.2),
  replayRatio: Number(process.env.LOAD_REPLAY_RATIO ?? 0.1),
  sqsMessages: Number(process.env.LOAD_SQS_MESSAGES ?? 1000),
  replicas: process.env.LOAD_REPLICAS ?? '3 (Compose, 256 MB each)',
};

const runId = new Date().toISOString().replace(/[:.]/g, '-');

// ------------------------------------------------------------------ types

interface Wallet {
  id: string;
  playerId: string;
}

type Category = 'spread' | 'hot' | 'replay';

interface Sample {
  category: Category;
  status: number; // 0 = network error
  ms: number;
}

interface SentRequest {
  key: string;
  body: Record<string, unknown>;
}

// ------------------------------------------------------------------ helpers

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body: json, ms: performance.now() - started };
  } catch {
    return { status: 0, body: {}, ms: performance.now() - started };
  }
}

/** Scrapes /metrics through the LB until every replica answered at least once; sums them. */
async function scrapeAllReplicas(expected = 3, attempts = 30): Promise<Map<string, number>> {
  const perInstance = new Map<string, Map<string, number>>();
  for (let i = 0; i < attempts && perInstance.size < expected; i++) {
    const text = await (await fetch(`${cfg.baseUrl}/metrics`)).text();
    const { instance, series } = parsePrometheus(text);
    perInstance.set(instance ?? `unknown-${String(i)}`, series);
  }
  const total = new Map<string, number>();
  for (const series of perInstance.values()) {
    for (const [key, value] of series) total.set(key, (total.get(key) ?? 0) + value);
  }
  total.set('__replicas_scraped', perInstance.size);
  return total;
}

function counterDelta(
  before: Map<string, number>,
  after: Map<string, number>,
  metric: string,
  ...f: string[]
) {
  return sumSeries(after, metric, ...f) - sumSeries(before, metric, ...f);
}

// ------------------------------------------------------------------ setup

async function setupWallets(): Promise<{ wallets: Wallet[]; hot: Wallet }> {
  const create = async (amount: string): Promise<Wallet> => {
    const playerId = crypto.randomUUID();
    const res = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
    if (res.status !== 201) throw new Error(`wallet creation failed: ${String(res.status)}`);
    return { id: String(res.body.id), playerId };
  };
  const wallets: Wallet[] = [];
  for (let i = 0; i < cfg.wallets; i += 20) {
    wallets.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(20, cfg.wallets - i) }, () => create('100000.00')),
      )),
    );
  }
  return { wallets, hot: await create('100000.00') };
}

// ------------------------------------------------------- experiment A: HTTP

async function runHttp(
  wallets: Wallet[],
  hot: Wallet,
): Promise<{ samples: Sample[]; elapsedS: number }> {
  const samples: Sample[] = [];
  const history: SentRequest[] = [];
  const deadline = performance.now() + cfg.durationS * 1000;
  const started = performance.now();

  const virtualUser = async () => {
    while (performance.now() < deadline) {
      let category: Category;
      let request: SentRequest;
      if (history.length > 50 && Math.random() < cfg.replayRatio) {
        category = 'replay';
        request = pick(history);
      } else {
        const isHot = Math.random() < cfg.hotRatio;
        category = isHot ? 'hot' : 'spread';
        const wallet = isHot ? hot : pick(wallets);
        const r = Math.random();
        const kind = r < 0.8 ? 'BET' : r < 0.95 ? 'WIN' : 'LOSS';
        const ext = `load-${crypto.randomUUID()}`;
        request = {
          key: `load:${ext}`,
          body: {
            providerId: 'load',
            externalTransactionId: ext,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'load-round',
            gameId: 'load-game',
            kind,
            money: { amount: kind === 'LOSS' ? '0.00' : '1.00', currency: 'BRL' },
          },
        };
        if (history.length < 5_000) history.push(request);
      }
      const res = await post('/wagering/transactions', request.body, {
        'Idempotency-Key': request.key,
      });
      samples.push({ category, status: res.status, ms: res.ms });
    }
  };
  await Promise.all(Array.from({ length: cfg.vus }, virtualUser));
  return { samples, elapsedS: (performance.now() - started) / 1000 };
}

// ------------------------------------------------------ experiment B: queue

async function runQueue(orm: MikroORM, wallets: Wallet[]) {
  const sqs = new SQSClient({
    region: 'us-east-1',
    endpoint: cfg.sqsEndpoint,
    useQueueUrlAsEndpoint: false,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: cfg.queueName }));
  const sentAt = new Map<string, number>();
  const prefix = `load-${runId}-`;
  const startedAt = Date.now();

  for (let i = 0; i < cfg.sqsMessages; i += 10) {
    const entries = Array.from({ length: Math.min(10, cfg.sqsMessages - i) }, (_, j) => {
      const wallet = pick(wallets);
      const ext = crypto.randomUUID();
      const messageId = `${prefix}${String(i + j)}`;
      sentAt.set(messageId, Date.now());
      return {
        Id: String(j),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'load-sqs',
            externalTransactionId: ext,
            idempotencyKey: `load-sqs:${ext}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'load-round',
            gameId: 'load-game',
            kind: 'BET',
            money: { amount: '1.00', currency: 'BRL' },
          },
        }),
      };
    });
    await sqs.send(new SendMessageBatchCommand({ QueueUrl, Entries: entries }));
  }
  const sendS = (Date.now() - startedAt) / 1000;

  const em = orm.em.fork();
  const deadline = Date.now() + 300_000;
  let done = 0;
  while (Date.now() < deadline) {
    const rows = await em.execute<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM inbox_messages WHERE message_id LIKE ?`,
      [`${prefix}%`],
    );
    done = rows[0]?.n ?? 0;
    if (done >= cfg.sqsMessages) break;
    await Bun.sleep(250);
  }
  const drainS = (Date.now() - startedAt) / 1000;
  const processed = await em.execute<{ message_id: string; processed_at: Date }[]>(
    `SELECT message_id, processed_at FROM inbox_messages WHERE message_id LIKE ?`,
    [`${prefix}%`],
  );
  const e2e = processed
    .map((r) => new Date(r.processed_at).getTime() - (sentAt.get(r.message_id) ?? Number.NaN))
    .filter(Number.isFinite);
  sqs.destroy();
  return { sent: cfg.sqsMessages, processed: done, sendS, drainS, e2e: latencyStats(e2e) };
}

// ------------------------------------------------------- outbox sampler

function startOutboxSampler(orm: MikroORM) {
  const samples: { t: number; pending: number; lagS: number }[] = [];
  const t0 = Date.now();
  const state = { stop: false }; // object, not a let: TS would narrow a local flag to "always false"
  const loop = (async () => {
    const em = orm.em.fork();
    while (!state.stop) {
      const rows = await em.execute<{ pending: number; lag: number | null }[]>(
        `SELECT count(*)::int AS pending,
                EXTRACT(EPOCH FROM (now() - min(occurred_at)))::float8 AS lag
           FROM outbox_messages WHERE published_at IS NULL`,
      );
      samples.push({
        t: (Date.now() - t0) / 1000,
        pending: rows[0]?.pending ?? 0,
        lagS: rows[0]?.lag ?? 0,
      });
      await Bun.sleep(1_000);
    }
  })();
  return {
    samples,
    stop: async () => {
      state.stop = true;
      await loop;
    },
  };
}

// ------------------------------------------------------------- report

function statusBreakdown(samples: Sample[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of samples) out[String(s.status)] = (out[String(s.status)] ?? 0) + 1;
  return out;
}

const fmt = (s: LatencyStats) =>
  `${String(round(s.p50))} / ${String(round(s.p95))} / ${String(round(s.p99))} / ${String(round(s.max))}`;

async function main(): Promise<void> {
  const ready = await fetch(`${cfg.baseUrl}/health/ready`).catch(() => undefined);
  if (ready?.status !== 200) {
    throw new Error(
      `Stack not ready at ${cfg.baseUrl} (start it: docker compose --profile app up -d)`,
    );
  }
  const orm = await MikroORM.init(createOrmConfig({ clientUrl: cfg.databaseUrl, poolMax: 2 }));

  console.log(`[load] setup: ${String(cfg.wallets)} wallets + 1 hot wallet`);
  const { wallets, hot } = await setupWallets();
  const before = await scrapeAllReplicas();
  const sampler = startOutboxSampler(orm);

  console.log(`[load] A: HTTP ${String(cfg.vus)} VUs x ${String(cfg.durationS)}s`);
  const http = await runHttp(wallets, hot);
  console.log(`[load] B: ${String(cfg.sqsMessages)} SQS messages`);
  const queue = await runQueue(orm, wallets);

  // Let the publishers drain what the load produced, measuring how long it takes.
  const drainStart = Date.now();
  while (Date.now() - drainStart < 120_000) {
    const last = sampler.samples.at(-1);
    if (last && last.pending === 0) break;
    await Bun.sleep(500);
  }
  const outboxDrainAfterLoadS = (Date.now() - drainStart) / 1000;
  await sampler.stop();
  const after = await scrapeAllReplicas();

  // Correctness under load: the invariant must hold for EVERY wallet.
  const em = orm.em.fork();
  const [inconsistent] = await em.execute<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM (
       SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        GROUP BY w.id
       HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
     ) x`,
  );
  await orm.close(true);

  // --------------------------------------------------------- aggregate
  const all = http.samples;
  const ok = all.filter((s) => s.status > 0 && s.status < 500);
  const errors = all.filter((s) => s.status === 0 || s.status >= 500);
  const byCat = (c: Category) =>
    latencyStats(all.filter((s) => s.category === c && s.status > 0).map((s) => s.ms));
  const lagMax = Math.max(0, ...sampler.samples.map((s) => s.lagS));
  const pendingMax = Math.max(0, ...sampler.samples.map((s) => s.pending));

  const result = {
    runId,
    environment: {
      cpu: `${cpus()[0]?.model.trim() ?? 'unknown'} (${String(cpus().length)} logical)`,
      ramGb: round(totalmem() / 1024 ** 3),
      os: `${platform()} ${release()}`,
      bun: Bun.version,
      target: cfg.baseUrl,
      replicas: cfg.replicas,
    },
    config: cfg,
    http: {
      requests: all.length,
      elapsedS: round(http.elapsedS),
      throughputRps: round(all.length / http.elapsedS),
      statuses: statusBreakdown(all),
      errorRatePct: round((errors.length / Math.max(1, all.length)) * 100, 2),
      latencyMs: {
        all: latencyStats(ok.map((s) => s.ms)),
        spread: byCat('spread'),
        hot: byCat('hot'),
        replay: byCat('replay'),
      },
    },
    queue: {
      ...queue,
      throughputMsgS: round(queue.processed / queue.drainS),
    },
    server: {
      replicasScraped: after.get('__replicas_scraped') ?? 0,
      lockTimeouts: counterDelta(
        before,
        after,
        'wagering_lock_conflicts_total',
        'kind="lock_timeout"',
      ),
      deadlocks: counterDelta(before, after, 'wagering_lock_conflicts_total', 'kind="deadlock"'),
      uniqueRaces: counterDelta(
        before,
        after,
        'wagering_lock_conflicts_total',
        'kind="unique_race"',
      ),
      duplicatesIdempotencyKey: counterDelta(
        before,
        after,
        'wagering_duplicates_detected_total',
        'layer="idempotency_key"',
      ),
      duplicatesInbox: counterDelta(
        before,
        after,
        'wagering_duplicates_detected_total',
        'layer="inbox"',
      ),
      consumerRetries: counterDelta(before, after, 'wagering_consumer_retries_total'),
      deadLettered: counterDelta(before, after, 'wagering_dead_lettered_total'),
      outboxPublished: counterDelta(before, after, 'wagering_outbox_published_total'),
      outboxPublishFailures: counterDelta(before, after, 'wagering_outbox_publish_failures_total'),
    },
    outbox: {
      maxPending: pendingMax,
      maxLagS: round(lagMax, 2),
      drainAfterLoadS: round(outboxDrainAfterLoadS, 1),
      timeline: sampler.samples,
    },
    correctness: { inconsistentWallets: inconsistent?.n ?? -1 },
  };

  // --------------------------------------------------------- output
  const dir = resolve(import.meta.dir, 'results');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${runId}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));

  const l = result.http.latencyMs;
  console.log(`
## Load test ${runId}

Environment: ${result.environment.cpu}, ${String(result.environment.ramGb)} GB RAM, ${result.environment.os}, Bun ${result.environment.bun}; replicas: ${result.environment.replicas}

### A. HTTP (closed loop, ${String(cfg.vus)} VUs, ${String(cfg.durationS)}s, hot=${String(cfg.hotRatio)}, replay=${String(cfg.replayRatio)})
| requests | throughput | error rate (5xx+network) | statuses |
|---|---|---|---|
| ${String(result.http.requests)} | ${String(result.http.throughputRps)} req/s | ${String(result.http.errorRatePct)}% | ${JSON.stringify(result.http.statuses)} |

| latency (ms) | p50 / p95 / p99 / max |
|---|---|
| all (non-error) | ${fmt(l.all)} |
| spread wallets | ${fmt(l.spread)} |
| hot wallet | ${fmt(l.hot)} |
| replays | ${fmt(l.replay)} |

### B. Queue (${String(queue.sent)} messages)
| processed | send time | drain time | throughput | end-to-end p50 / p95 / p99 / max (ms) |
|---|---|---|---|---|
| ${String(queue.processed)} | ${String(round(queue.sendS))}s | ${String(round(queue.drainS))}s | ${String(result.queue.throughputMsgS)} msg/s | ${fmt(queue.e2e)} |

### Server side (summed over ${String(result.server.replicasScraped)} replicas)
lock timeouts ${String(result.server.lockTimeouts)} · deadlocks ${String(result.server.deadlocks)} · unique races ${String(result.server.uniqueRaces)} · duplicates (key/inbox) ${String(result.server.duplicatesIdempotencyKey)}/${String(result.server.duplicatesInbox)} · consumer retries ${String(result.server.consumerRetries)} · DLQ ${String(result.server.deadLettered)} · events published ${String(result.server.outboxPublished)} (failures ${String(result.server.outboxPublishFailures)})

### Outbox
max backlog ${String(pendingMax)} events · max lag ${String(result.outbox.maxLagS)}s · drained ${String(result.outbox.drainAfterLoadS)}s after the load

### Correctness under load
wallets with balance != ledger: **${String(result.correctness.inconsistentWallets)}**

raw: ${file}
`);
  if (result.correctness.inconsistentWallets !== 0) process.exit(2);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
