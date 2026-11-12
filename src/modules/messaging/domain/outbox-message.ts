import { type BackoffOptions, nextAttemptAt } from '../../../shared/domain/backoff';
import { InvalidTransactionStateError } from '../../../shared/domain/errors';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export const DEFAULT_OUTBOX_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 60_000 };

/** Integration event persisted in the same SQL transaction as the state change that caused it. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /** The outbox id is the eventId, so consumers can dedupe republished events. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze({ ...event.toJSON() }) as Readonly<Record<string, unknown>>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and computes the next nextAttemptAt (exponential backoff). */
  scheduleRetry(now: Date, backoff: BackoffOptions = DEFAULT_OUTBOX_BACKOFF): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt(now, this._attempts, backoff);
  }
}
