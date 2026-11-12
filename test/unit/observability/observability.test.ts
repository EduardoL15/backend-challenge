import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import { addContext, currentContext, withContext } from '../../../src/observability/context';
import { PinoNestLogger, createRootLogger } from '../../../src/observability/logger';
import { PrometheusMetrics } from '../../../src/observability/prometheus-metrics';

function capture(): { lines: () => Record<string, unknown>[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('log context (AsyncLocalStorage)', () => {
  it('is inherited across awaits and enriched in place', async () => {
    await withContext({ correlationId: 'c1' }, async () => {
      await Promise.resolve();
      addContext({ transactionId: 't1' });
      await new Promise((r) => setTimeout(r, 1));
      expect(currentContext()).toEqual({ correlationId: 'c1', transactionId: 't1' });
    });
    expect(currentContext()).toEqual({});
  });

  it('nested contexts override without leaking back to the parent', () => {
    withContext({ correlationId: 'outer', walletId: 'w' }, () => {
      withContext({ correlationId: 'inner' }, () => {
        expect(currentContext()).toEqual({ correlationId: 'inner', walletId: 'w' });
      });
      expect(currentContext().correlationId).toBe('outer');
    });
  });

  it('concurrent executions never see each other context', async () => {
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        withContext({ correlationId: id }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          return currentContext().correlationId;
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});

describe('structured logger', () => {
  it('writes JSON lines with service, instance and the current context', () => {
    const out = capture();
    const logger = createRootLogger({ level: 'info', service: 'svc', destination: out.stream });
    withContext({ correlationId: 'corr', transactionId: 'tx', walletId: 'w' }, () => {
      logger.info({ outcome: 'processed' }, 'done');
    });
    expect(out.lines()[0]).toMatchObject({
      level: 'info',
      service: 'svc',
      correlationId: 'corr',
      transactionId: 'tx',
      walletId: 'w',
      outcome: 'processed',
      msg: 'done',
    });
    expect(typeof out.lines()[0]?.instance).toBe('string');
  });

  it('redacts money, balances and payloads even if someone logs them', () => {
    const out = capture();
    const logger = createRootLogger({ level: 'info', service: 'svc', destination: out.stream });
    logger.info({
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '975.00', currency: 'BRL' },
      body: { secret: true },
      nested: { amount: '1.00', payload: { x: 1 } },
      walletId: 'kept',
    });
    const raw = JSON.stringify(out.lines()[0]);
    expect(raw).not.toContain('25.00');
    expect(raw).not.toContain('975.00');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('"1.00"');
    expect(out.lines()[0]?.walletId).toBe('kept');
  });

  it('adapts the Nest Logger API (object and string messages, context name)', () => {
    const out = capture();
    const nest = new PinoNestLogger(
      createRootLogger({ level: 'info', service: 'svc', destination: out.stream }),
    );
    nest.log({ msg: 'Message handled', outcome: 'duplicate' }, 'Consumer');
    nest.warn('plain text', 'Worker');
    nest.error(new Error('boom'), 'X');
    const [a, b, c] = out.lines();
    expect(a).toMatchObject({
      level: 'info',
      context: 'Consumer',
      msg: 'Message handled',
      outcome: 'duplicate',
    });
    expect(b).toMatchObject({ level: 'warn', context: 'Worker', msg: 'plain text' });
    expect(c).toMatchObject({ level: 'error', msg: 'boom' });
  });
});

describe('PrometheusMetrics', () => {
  it('exposes the catalogue with bounded labels', async () => {
    const m = new PrometheusMetrics({ defaultMetrics: false });
    m.wagerHandled({
      source: 'http',
      kind: 'BET',
      status: 'PROCESSED',
      replay: false,
      durationMs: 12,
    });
    m.duplicateDetected('inbox', 'sqs');
    m.lockConflict('lock_timeout');
    m.consumerMessage('retry', 5);
    m.consumerRetry();
    m.deadLettered('MALFORMED_JSON');
    m.outboxPublished(3);
    m.outboxPublishFailed(0);
    m.reconciliation(false);
    m.httpRequest('POST', '/wagering/transactions', 201, 20);
    m.scrapeGauge('wagering_test_gauge', 'test', () => Promise.resolve(7));

    const text = await m.registry.metrics();
    for (const line of [
      'wagering_transactions_total{source="http",kind="BET",status="PROCESSED",replay="false"} 1',
      'wagering_duplicates_detected_total{layer="inbox",source="sqs"} 1',
      'wagering_lock_conflicts_total{kind="lock_timeout"} 1',
      'wagering_consumer_retries_total 1',
      'wagering_dead_lettered_total{reason="MALFORMED_JSON"} 1',
      'wagering_outbox_published_total 3',
      'wagering_reconciliation_mismatches_total 1',
      'wagering_test_gauge 7',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toContain('wagering_processing_duration_seconds_bucket');
    expect(text).toContain(
      'http_request_duration_seconds_count{method="POST",route="/wagering/transactions",status="201"} 1',
    );
  });

  it('a gauge whose source fails reports NaN instead of a misleading 0', async () => {
    const m = new PrometheusMetrics({ defaultMetrics: false });
    m.scrapeGauge('wagering_broken_gauge', 'broken', () => Promise.reject(new Error('db down')));
    expect(await m.registry.metrics()).toContain('wagering_broken_gauge Nan');
  });
});
