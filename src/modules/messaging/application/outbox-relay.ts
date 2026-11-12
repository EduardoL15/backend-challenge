import type { BackoffOptions } from '../../../shared/domain/backoff';
import type { Clock } from '../../../shared/application/ports';
import type { OutboxMessage } from '../domain/outbox-message';

/** messageId -> error description, for the messages that could NOT be published. */
export type PublishFailures = Map<string, string>;

export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishFailures>;
}
export const EVENT_PUBLISHER = Symbol('EventPublisher');

export interface OutboxStore {
  /**
   * Claims up to `limit` due messages for the duration of `handle` (FOR UPDATE SKIP LOCKED:
   * concurrent publishers get disjoint batches), then persists the state `handle` left on
   * them in the SAME transaction. If the process dies before COMMIT, the locks vanish and the
   * messages are picked up again by another instance (at-least-once).
   */
  processDue(
    limit: number,
    now: Date,
    handle: (messages: OutboxMessage[]) => Promise<PublishFailures>,
  ): Promise<number>;

  /** Unpublished messages and the age of the oldest one (outbox lag; 0 when empty). */
  pendingStats(now: Date): Promise<{ count: number; oldestAgeMs: number }>;
}
export const OUTBOX_STORE = Symbol('OutboxStore');

export interface OutboxRelaySettings {
  batchSize: number;
  backoff: BackoffOptions;
}

/**
 * Publishes committed events. Never gives up on a message (there is no max attempts:
 * a confirmed event must not be lost); failures back off exponentially and are visible
 * through attempts/last_error and the outbox lag metric.
 */
export class OutboxRelay {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly settings: OutboxRelaySettings,
  ) {}

  /** Returns how many messages were handled (published or rescheduled). */
  async relayOnce(): Promise<{ handled: number; failed: number }> {
    let failed = 0;
    const now = this.clock.now();
    const handled = await this.store.processDue(this.settings.batchSize, now, async (messages) => {
      const failures = await this.publisher.publish(messages);
      for (const message of messages) {
        if (failures.has(message.id)) {
          message.scheduleRetry(now, this.settings.backoff);
          failed++;
        } else {
          message.markPublished(now);
        }
      }
      return failures;
    });
    return { handled, failed };
  }
}
