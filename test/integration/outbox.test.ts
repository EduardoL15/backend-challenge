/**
 * Transactional outbox relay against real PostgreSQL + LocalStack. Each "instance" uses its
 * own MikroORM pool, so concurrency between publishers is real (separate DB sessions).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  type Message,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  type EventPublisher,
  OutboxRelay,
  type PublishFailures,
} from '../../src/modules/messaging/application/outbox-relay';
import type { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { MikroOrmOutboxStore } from '../../src/modules/messaging/infra/persistence/mikro-orm-outbox-store';
import { QueueUrls } from '../../src/modules/messaging/infra/sqs/sqs';
import { SqsEventPublisher } from '../../src/modules/messaging/infra/sqs/sqs-event-publisher';
import type { Clock } from '../../src/shared/application/ports';
import { api, startTestApp, type TestApp } from '../support/app';
import { createTestOrm, query, resetSchema, uuid } from '../support/db';
import { testSqsClient } from '../support/sqs';

let orm: MikroORM;
let sqs: SQSClient;
let app: TestApp;
let eventsQueueName: string;
let eventsQueueUrl: string;

class ManualClock implements Clock {
  constructor(private current = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const BACKOFF = { baseMs: 1_000, maxMs: 60_000, random: () => 0 };

function relayFor(
  instanceOrm: MikroORM,
  publisher: EventPublisher,
  clock: Clock = new ManualClock(),
  batchSize = 50,
) {
  return new OutboxRelay(new MikroOrmOutboxStore(instanceOrm), publisher, clock, {
    batchSize,
    backoff: BACKOFF,
  });
}

const realPublisher = (queueName = eventsQueueName) =>
  new SqsEventPublisher(sqs, new QueueUrls(sqs), queueName);

/** Wraps a publisher and counts how many times each event was handed to SQS. */
class RecordingPublisher implements EventPublisher {
  readonly sends = new Map<string, number>();
  constructor(private readonly inner: EventPublisher) {}
  async publish(messages: readonly OutboxMessage[]): Promise<PublishFailures> {
    for (const m of messages) this.sends.set(m.id, (this.sends.get(m.id) ?? 0) + 1);
    return this.inner.publish(messages);
  }
}

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  sqs = testSqsClient();
  eventsQueueName = `test-events-${uuid().slice(0, 8)}.fifo`;
  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: eventsQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  eventsQueueUrl = created.QueueUrl ?? '';
  // API only: events are committed to the outbox but nobody publishes them.
  app = await startTestApp({ APP_ROLES: 'api' });
});

afterAll(async () => {
  await app.close();
  await sqs.send(new DeleteQueueCommand({ QueueUrl: eventsQueueUrl }));
  sqs.destroy();
  await orm.close(true);
});

// ---------------------------------------------------------------- helpers

async function produceEvents(bets: number): Promise<void> {
  const playerId = uuid();
  const res = await api<{ id: string }>(app.baseUrl, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
  });
  for (let i = 0; i < bets; i++) {
    const ext = uuid();
    await api(app.baseUrl, 'POST', '/wagering/transactions', {
      headers: { 'Idempotency-Key': `p:${ext}` },
      body: {
        providerId: 'p',
        externalTransactionId: ext,
        playerId,
        walletId: res.body.id,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
    });
  }
}

const count = async (where: string): Promise<number> =>
  (
    await query<{ n: number }>(orm, `SELECT count(*)::int AS n FROM outbox_messages WHERE ${where}`)
  )[0]?.n ?? -1;

const pendingIds = async (): Promise<string[]> =>
  (
    await query<{ id: string }>(orm, 'SELECT id FROM outbox_messages WHERE published_at IS NULL')
  ).map((r) => r.id);

async function receiveAll(): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    const batch = res.Messages ?? [];
    if (batch.length === 0) return all;
    all.push(...batch);
    for (const m of batch) {
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: eventsQueueUrl, ReceiptHandle: m.ReceiptHandle }),
      );
    }
  }
}

async function drainWith(relay: OutboxRelay): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { handled } = await relay.relayOnce();
    if (handled === 0) return;
  }
}

// ------------------------------------------------------------------- tests

describe('outbox relay', () => {
  it('events committed by one instance are published by another one', async () => {
    await produceEvents(3);
    const pending = await pendingIds();
    expect(pending.length).toBe(1 + 3 * 2); // opening balance change + (processed + balance changed) per bet

    const other = await createTestOrm(3);
    try {
      await drainWith(relayFor(other, realPublisher()));
    } finally {
      await other.close(true);
    }

    expect(await count('published_at IS NULL')).toBe(0);
    const received = await receiveAll();
    const ids = received.map((m) => m.MessageAttributes?.eventId?.StringValue);
    expect(ids.sort()).toEqual([...pending].sort());
    for (const m of received) {
      const body = JSON.parse(m.Body ?? '{}') as {
        eventId: string;
        eventType: string;
        data: unknown;
      };
      expect(body.eventId).toBe(m.MessageAttributes?.eventId?.StringValue ?? 'missing');
      expect(body.eventType).toBe(m.MessageAttributes?.eventType?.StringValue ?? 'missing');
      expect(['WalletBalanceChanged', 'WagerTransactionProcessed']).toContain(body.eventType);
    }
  }, 30_000);

  it('process dies after publishing but before COMMIT: the event is re-published, never lost', async () => {
    await produceEvents(1);
    const pending = await pendingIds();
    expect(pending.length).toBe(3);

    const crashing: EventPublisher = {
      publish: async (messages) => {
        await realPublisher().publish(messages);
        throw new Error('process killed right after SendMessageBatch');
      },
    };
    let crashed: unknown;
    try {
      await relayFor(orm, crashing).relayOnce();
    } catch (error) {
      crashed = error;
    }
    expect(String(crashed)).toContain('process killed');
    // Rolled back: still pending, attempts untouched, locks released.
    expect(await count('published_at IS NULL')).toBe(3);
    expect(await count('attempts > 0')).toBe(0);

    // Another instance takes over and publishes again (same eventId => same dedup id).
    await drainWith(relayFor(orm, realPublisher()));
    expect(await count('published_at IS NULL')).toBe(0);

    const received = await receiveAll();
    const ids = received.map((m) => m.MessageAttributes?.eventId?.StringValue ?? '');
    // Every event arrived; duplicates (if any) carry the same eventId, so consumers can dedupe.
    expect(new Set(ids)).toEqual(new Set(pending));
  }, 30_000);

  it('a publish failure backs off, records the error and keeps the event until it succeeds', async () => {
    await produceEvents(1);
    const clock = new ManualClock();
    const broken = relayFor(orm, realPublisher('queue-that-does-not-exist.fifo'), clock);

    const first = await broken.relayOnce();
    expect(first).toEqual({ handled: 3, failed: 3 });
    const rows = await query<{
      attempts: number;
      last_error: string | null;
      published_at: Date | null;
    }>(
      orm,
      'SELECT attempts, last_error, published_at FROM outbox_messages WHERE published_at IS NULL',
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('Queue lookup failed');
    }

    // Not due yet: nothing to do until the backoff elapses.
    expect((await relayFor(orm, realPublisher(), clock).relayOnce()).handled).toBe(0);

    clock.advance(1_000);
    await drainWith(relayFor(orm, realPublisher(), clock));
    expect(await count('published_at IS NULL')).toBe(0);
    expect(await count('last_error IS NOT NULL')).toBe(0);
    expect((await receiveAll()).length).toBe(3);
  }, 30_000);

  it('three concurrent publishers never claim the same event and publish all of them', async () => {
    await produceEvents(40);
    const pending = await pendingIds();
    expect(pending.length).toBe(1 + 40 * 2); // opening + (processed + balance changed) per bet

    const instances = await Promise.all([createTestOrm(3), createTestOrm(3), createTestOrm(3)]);
    const recorders = instances.map(() => new RecordingPublisher(realPublisher()));
    try {
      await Promise.all(
        instances.map(async (instanceOrm, i) => {
          const recorder = recorders[i];
          if (!recorder) return;
          const relay = relayFor(instanceOrm, recorder, new ManualClock(), 5);
          for (;;) {
            const { handled } = await relay.relayOnce();
            if (handled === 0) return;
          }
        }),
      );
    } finally {
      await Promise.all(instances.map((o) => o.close(true)));
    }

    const totalSends = new Map<string, number>();
    for (const recorder of recorders) {
      for (const [id, n] of recorder.sends) totalSends.set(id, (totalSends.get(id) ?? 0) + n);
    }
    expect([...totalSends.keys()].sort()).toEqual([...pending].sort());
    expect([...totalSends.values()].every((n) => n === 1)).toBe(true); // no double claim
    expect(recorders.filter((r) => r.sends.size > 0).length).toBeGreaterThan(1); // really concurrent
    expect(await count('published_at IS NULL')).toBe(0);
    expect((await receiveAll()).length).toBe(pending.length);
  }, 60_000);
});
