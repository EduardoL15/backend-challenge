import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { translateDbError } from '../../../../infrastructure/persistence/db-errors';
import type { OutboxStore, PublishFailures } from '../../application/outbox-relay';
import type { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageMapper } from './messaging.mapper';
import { OutboxMessageRecord } from './messaging.schema';

export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async processDue(
    limit: number,
    now: Date,
    handle: (messages: OutboxMessage[]) => Promise<PublishFailures>,
  ): Promise<number> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // PESSIMISTIC_PARTIAL_WRITE = FOR UPDATE SKIP LOCKED.
        const records = await em.find(
          OutboxMessageRecord,
          {
            publishedAt: null,
            $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
          },
          {
            orderBy: { occurredAt: 'asc', id: 'asc' },
            limit,
            lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          },
        );
        if (records.length === 0) return 0;

        const messages = records.map((r) => OutboxMessageMapper.toDomain(r));
        const failures = await handle(messages);
        messages.forEach((message, i) => {
          const record = records[i];
          if (!record) return;
          const next = OutboxMessageMapper.toRecord(message);
          next.lastError = failures.get(message.id)?.slice(0, 2000) ?? null;
          em.assign(record, next);
        });
        return messages.length;
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }

  async oldestPendingAgeMs(now: Date): Promise<number | undefined> {
    const rows = await this.orm.em
      .fork()
      .execute<{ oldest: Date | null }[]>(
        'SELECT min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL',
      );
    const oldest = rows[0]?.oldest;
    return oldest ? Math.max(0, now.getTime() - new Date(oldest).getTime()) : undefined;
  }
}
