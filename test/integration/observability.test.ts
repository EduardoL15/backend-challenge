/**
 * Observability against the real stack: Prometheus metrics produced by real requests,
 * readiness with a dependency down, readiness while draining, lock-conflict accounting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { HealthService } from '../../src/health/health.controller';
import { api, startTestApp, type TestApp } from '../support/app';
import { createTestOrm, resetSchema, uuid } from '../support/db';

const GOOD_SQS = { AWS_ENDPOINT_URL: 'http://localhost:4566' };

let orm: MikroORM;
let app: TestApp;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  app = await startTestApp({ APP_ROLES: 'api', DB_LOCK_TIMEOUT_MS: '200', ...GOOD_SQS });
});

afterAll(async () => {
  await app.close();
  await orm.close(true);
});

async function metricsText(base = app.baseUrl): Promise<string> {
  const res = await fetch(`${base}/metrics`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
}

function metricValue(text: string, series: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

async function createWallet(amount: string) {
  const playerId = uuid();
  const res = await api<{ id: string }>(app.baseUrl, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount, currency: 'BRL' } },
  });
  return { id: res.body.id, playerId };
}

function bet(w: { id: string; playerId: string }, ext: string, amount: string) {
  return api(app.baseUrl, 'POST', '/wagering/transactions', {
    headers: { 'Idempotency-Key': `p:${ext}` },
    body: {
      providerId: 'p',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  });
}

describe('metrics', () => {
  it('counts transactions by status, replays as duplicates, and latency by route template', async () => {
    const before = await metricsText();
    const w = await createWallet('10.00');
    await bet(w, 'ok-1', '4.00'); // PROCESSED
    await bet(w, 'ok-1', '4.00'); // replay
    await bet(w, 'big', '50.00'); // REJECTED
    const after = await metricsText();

    const delta = (series: string) => metricValue(after, series) - metricValue(before, series);
    expect(
      delta(
        'wagering_transactions_total{source="http",kind="BET",status="PROCESSED",replay="false"}',
      ),
    ).toBe(1);
    expect(
      delta(
        'wagering_transactions_total{source="http",kind="BET",status="PROCESSED",replay="true"}',
      ),
    ).toBe(1);
    expect(
      delta(
        'wagering_transactions_total{source="http",kind="BET",status="REJECTED",replay="false"}',
      ),
    ).toBe(1);
    expect(delta('wagering_duplicates_detected_total{layer="idempotency_key",source="http"}')).toBe(
      1,
    );
    expect(after).toContain('wagering_processing_duration_seconds_bucket');
    // Route TEMPLATES only: an id in a label would explode cardinality.
    expect(after).toContain('route="/wagering/transactions"');
    const routeLabels = [...after.matchAll(/route="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(routeLabels.some((r) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(r))).toBe(false);
  });

  it('exposes outbox backlog/lag gauges computed from the database', async () => {
    const text = await metricsText();
    // This app has no "outbox" role, so the events of the previous test are still pending.
    expect(metricValue(text, 'wagering_outbox_pending_events')).toBeGreaterThan(0);
    expect(metricValue(text, 'wagering_outbox_lag_seconds')).toBeGreaterThanOrEqual(0);
    expect(text).toContain('wagering_dlq_messages ');
    expect(text).toContain('wagering_process_'); // default runtime metrics
  });

  it('counts a lock timeout as a lock conflict and answers 503 with Retry-After', async () => {
    const w = await createWallet('100.00');
    const before = metricValue(
      await metricsText(),
      'wagering_lock_conflicts_total{kind="lock_timeout"}',
    );
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT 1 FROM wallets WHERE id = ? FOR UPDATE', [w.id]);
      await new Promise((r) => setTimeout(r, 1_000));
    });
    await new Promise((r) => setTimeout(r, 100));
    const res = await bet(w, 'blocked', '1.00');
    await holder;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    const after = metricValue(
      await metricsText(),
      'wagering_lock_conflicts_total{kind="lock_timeout"}',
    );
    expect(after - before).toBe(1);
  });
});

describe('health', () => {
  it('readiness is 200 when PostgreSQL and SQS answer', async () => {
    const res = await api(app.baseUrl, 'GET', '/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      checks: { database: 'up', sqs: 'up' },
      draining: false,
    });
  });

  it('readiness is 503 (and says which dependency) when SQS is unreachable; liveness stays 200', async () => {
    const broken = await startTestApp({
      APP_ROLES: 'api',
      AWS_ENDPOINT_URL: 'http://127.0.0.1:4599',
    });
    try {
      const ready = await api(broken.baseUrl, 'GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({
        status: 'unavailable',
        checks: { database: 'up', sqs: 'down' },
      });
      expect((await api(broken.baseUrl, 'GET', '/health/live')).status).toBe(200);
    } finally {
      await broken.close();
      Object.assign(process.env, GOOD_SQS);
    }
  }, 20_000);

  it('readiness flips to 503 as soon as shutdown starts (drain traffic first)', async () => {
    const draining = await startTestApp({ APP_ROLES: 'api', ...GOOD_SQS });
    try {
      draining.app.get(HealthService).beforeApplicationShutdown();
      const ready = await api(draining.baseUrl, 'GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({ draining: true, checks: { database: 'up', sqs: 'up' } });
    } finally {
      await draining.close();
    }
  });
});
