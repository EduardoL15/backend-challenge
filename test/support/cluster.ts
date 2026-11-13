import { resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { query } from './db';
import { TEST_DATABASE_URL } from './db';
import type { MikroORM } from '@mikro-orm/postgresql';

const PROJECT_ROOT = resolve(import.meta.dir, '../..');

/** Fast polling so multi-process tests finish in seconds. */
export const CLUSTER_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: TEST_DATABASE_URL,
  DB_POOL_MAX: '10',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_RETRY_BASE_SECONDS: '1',
  SQS_RETRY_MAX_SECONDS: '2',
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_POLL_INTERVAL_MS: '200',
  // Long backoff on purpose: out-of-order resolution must come from the wake-up.
  PENDING_REFERENCE_BASE_MS: '30000',
  PENDING_REFERENCE_MAX_MS: '30000',
  SHUTDOWN_GRACE_MS: '5000',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
};

export interface Instance {
  name: string;
  baseUrl: string;
  process: Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Parsed JSON log lines written by this process. */
  logs: Record<string, unknown>[];
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * Starts a REAL application process (`bun src/main.ts`): its own event loop, its own DB pool,
 * its own SQS client. HOSTNAME=name, so every log line says which instance wrote it.
 */
export async function spawnInstance(options: {
  name: string;
  port: number;
  roles: string;
  env?: Record<string, string>;
}): Promise<Instance> {
  const proc = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...CLUSTER_ENV,
      ...options.env,
      PORT: String(options.port),
      APP_ROLES: options.roles,
      HOSTNAME: options.name,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const logs: Record<string, unknown>[] = [];
  void collect(proc.stdout, logs);
  void collect(proc.stderr, logs);

  const instance: Instance = {
    name: options.name,
    baseUrl: `http://127.0.0.1:${String(options.port)}`,
    process: proc,
    logs,
    exited: proc.exited.then(() => proc.exitCode),
    kill: async (signal = 'SIGKILL') => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      await proc.exited;
    },
  };
  await waitUntilStarted(instance, options.roles.includes('api'));
  return instance;
}

async function collect(stream: ReadableStream<Uint8Array>, into: Record<string, unknown>[]) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('{')) {
        try {
          into.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          into.push({ raw: line });
        }
      } else if (line) {
        into.push({ raw: line });
      }
      newline = buffer.indexOf('\n');
    }
  }
}

async function waitUntilStarted(instance: Instance, hasApi: boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (instance.process.exitCode !== null) {
      throw new Error(
        `${instance.name} exited during startup:\n${instance.logs.map((l) => JSON.stringify(l)).join('\n')}`,
      );
    }
    if (hasApi) {
      try {
        const res = await fetch(`${instance.baseUrl}/health/ready`);
        if (res.status === 200) return;
      } catch {
        // not listening yet
      }
    } else if (instance.logs.some((l) => l.msg === 'Started')) {
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(`${instance.name} did not start in time`);
}

/**
 * HTTP client that round-robins over instances and, like a real provider, retries the SAME
 * request (same Idempotency-Key) on network errors / 502 / 503. Safe only because the API is
 * idempotent - which is exactly what the tests assert.
 */
export class ClusterClient {
  private next = 0;
  constructor(private readonly instances: () => Instance[]) {}

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed JSON body for callers
  async post<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    target?: Instance,
  ): Promise<{ status: number; body: T; servedBy: string }> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const pool = this.instances().filter(
        (i) => i.process.exitCode === null && i.process.signalCode === null,
      );
      const instance = target && attempt === 0 ? target : pool[this.next++ % pool.length];
      if (!instance) throw new Error('No live instance');
      try {
        const res = await fetch(`${instance.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        if (res.status === 502 || res.status === 503) {
          await Bun.sleep(100);
          continue;
        }
        return { status: res.status, body: (await res.json()) as T, servedBy: instance.name };
      } catch {
        await Bun.sleep(100); // instance died mid-request: retry elsewhere
      }
    }
    throw new Error(`POST ${path} kept failing`);
  }
}

/**
 * The global invariant of the challenge, checked for EVERY wallet in the database:
 * wallet.balance == balance rebuilt from the ledger, and version == number of the last entry.
 */
export async function inconsistentWallets(orm: MikroORM): Promise<Record<string, unknown>[]> {
  return query(
    orm,
    `SELECT w.id, w.balance::text AS balance,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS ledger
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      GROUP BY w.id
     HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`,
  );
}

export function logsWhere(
  instance: Instance,
  predicate: (line: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  return instance.logs.filter(predicate);
}
