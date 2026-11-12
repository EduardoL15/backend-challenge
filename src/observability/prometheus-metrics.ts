import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type {
  AppMetrics,
  ConsumerOutcome,
  DuplicateLayer,
  LockConflictKind,
  WagerSource,
} from '../shared/application/metrics';

export const PROMETHEUS_REGISTRY = Symbol('PrometheusRegistry');

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Metric catalogue (all prefixed "wagering_"). Label values are bounded enums
 * (status, kind, source, outcome, reason) - never ids - to keep cardinality fixed.
 */
export class PrometheusMetrics implements AppMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions handled, by final status of the request',
    labelNames: ['source', 'kind', 'status', 'replay'],
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager transaction (including race retries)',
    labelNames: ['source', 'status'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicates stopped by the inbox (transport) or the idempotency key (business)',
    labelNames: ['layer', 'source'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and unique-constraint races resolved by retry',
    labelNames: ['kind'],
    registers: [this.registry],
  });
  private readonly consumerMessages = new Counter({
    name: 'wagering_consumer_messages_total',
    help: 'SQS messages handled by outcome',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  private readonly consumerDuration = new Histogram({
    name: 'wagering_consumer_message_duration_seconds',
    help: 'Time to handle one SQS message',
    labelNames: ['outcome'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_consumer_retries_total',
    help: 'SQS messages scheduled for retry after a transient failure',
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'wagering_dead_lettered_total',
    help: 'Messages sent to (or about to be redriven to) the DLQ, by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly outboxPublishedCounter = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Integration events published from the outbox',
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Integration event publish attempts that failed (will be retried)',
    registers: [this.registry],
  });
  private readonly pendingResolutions = new Counter({
    name: 'wagering_pending_reference_resolutions_total',
    help: 'PENDING_REFERENCE re-evaluations by result',
    labelNames: ['result'],
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: 'wagering_reconciliations_total',
    help: 'Wallet reconciliations by result',
    labelNames: ['consistent'],
    registers: [this.registry],
  });
  private readonly reconciliationMismatches = new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Wallets whose balance diverged from the ledger (never auto-corrected)',
    registers: [this.registry],
  });
  private readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route template',
    labelNames: ['method', 'route', 'status'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  constructor(options: { defaultMetrics?: boolean } = {}) {
    if (options.defaultMetrics !== false) {
      collectDefaultMetrics({ register: this.registry, prefix: 'wagering_process_' });
    }
  }

  /** Registers a gauge whose value is computed at scrape time (outbox lag, DLQ depth...). */
  scrapeGauge(name: string, help: string, read: () => Promise<number | undefined>): void {
    new Gauge({
      name,
      help,
      registers: [this.registry],
      async collect() {
        try {
          this.set((await read()) ?? 0);
        } catch {
          this.set(Number.NaN); // unknown, rather than a misleading 0
        }
      },
    });
  }

  wagerHandled(event: {
    source: WagerSource;
    kind: string;
    status: string;
    replay: boolean;
    durationMs: number;
  }): void {
    this.transactions.inc({
      source: event.source,
      kind: event.kind,
      status: event.status,
      replay: String(event.replay),
    });
    this.processing.observe(
      { source: event.source, status: event.status },
      event.durationMs / 1000,
    );
  }

  duplicateDetected(layer: DuplicateLayer, source: WagerSource): void {
    this.duplicates.inc({ layer, source });
  }

  lockConflict(kind: LockConflictKind): void {
    this.lockConflicts.inc({ kind });
  }

  consumerMessage(outcome: ConsumerOutcome, durationMs: number): void {
    this.consumerMessages.inc({ outcome });
    this.consumerDuration.observe({ outcome }, durationMs / 1000);
  }

  consumerRetry(): void {
    this.retries.inc();
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  outboxPublished(count: number): void {
    if (count > 0) this.outboxPublishedCounter.inc(count);
  }

  outboxPublishFailed(count: number): void {
    if (count > 0) this.outboxFailures.inc(count);
  }

  pendingResolution(result: string): void {
    this.pendingResolutions.inc({ result });
  }

  reconciliation(consistent: boolean): void {
    this.reconciliations.inc({ consistent: String(consistent) });
    if (!consistent) this.reconciliationMismatches.inc();
  }

  httpRequest(method: string, route: string, status: number, durationMs: number): void {
    this.httpDuration.observe({ method, route, status: String(status) }, durationMs / 1000);
  }
}
