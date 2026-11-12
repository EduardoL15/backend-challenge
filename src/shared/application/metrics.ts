export type WagerSource = 'http' | 'sqs' | 'pending';

export type ConsumerOutcome =
  | 'processed'
  | 'rejected'
  | 'pending_reference'
  | 'duplicate'
  | 'business_error'
  | 'retry'
  | 'dead_letter';

/** Where a duplicate was stopped: transport level (inbox) or business level (idempotency key). */
export type DuplicateLayer = 'inbox' | 'idempotency_key';

export type LockConflictKind = 'lock_timeout' | 'deadlock' | 'unique_race';

/**
 * Application metrics port. The application layer reports facts; the Prometheus adapter
 * (observability) decides names, labels and buckets.
 */
export interface AppMetrics {
  wagerHandled(event: {
    source: WagerSource;
    kind: string;
    status: string;
    replay: boolean;
    durationMs: number;
  }): void;
  duplicateDetected(layer: DuplicateLayer, source: WagerSource): void;
  lockConflict(kind: LockConflictKind): void;
  consumerMessage(outcome: ConsumerOutcome, durationMs: number): void;
  consumerRetry(): void;
  deadLettered(reason: string): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(count: number): void;
  pendingResolution(result: string): void;
  reconciliation(consistent: boolean): void;
  httpRequest(method: string, route: string, status: number, durationMs: number): void;
}
export const METRICS = Symbol('AppMetrics');

/** For unit tests and wiring without Prometheus. */
export class NoopMetrics implements AppMetrics {
  wagerHandled(): void {}
  duplicateDetected(): void {}
  lockConflict(): void {}
  consumerMessage(): void {}
  consumerRetry(): void {}
  deadLettered(): void {}
  outboxPublished(): void {}
  outboxPublishFailed(): void {}
  pendingResolution(): void {}
  reconciliation(): void {}
  httpRequest(): void {}
}
