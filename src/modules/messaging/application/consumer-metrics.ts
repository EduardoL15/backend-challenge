export type ConsumerOutcome =
  | 'processed'
  | 'rejected'
  | 'pending_reference'
  | 'duplicate'
  | 'business_error'
  | 'retry'
  | 'dead_letter';

/** Hook for consumer metrics (Prometheus implementation comes with the observability phase). */
export interface ConsumerMetrics {
  messageHandled(outcome: ConsumerOutcome, durationMs: number): void;
}
export const CONSUMER_METRICS = Symbol('ConsumerMetrics');

export class NoopConsumerMetrics implements ConsumerMetrics {
  messageHandled(): void {
    // replaced by the Prometheus implementation
  }
}
