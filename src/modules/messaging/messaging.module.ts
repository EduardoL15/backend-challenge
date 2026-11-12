import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { CLOCK, type Clock } from '../../shared/application/ports';
import {
  EVENT_PUBLISHER,
  type EventPublisher,
  OUTBOX_STORE,
  OutboxRelay,
  type OutboxStore,
} from './application/outbox-relay';
import { MessagingGauges } from './infra/messaging-gauges';
import { OUTBOX_RELAY, OutboxPublisherWorker } from './infra/outbox-publisher.worker';
import { MikroOrmOutboxStore } from './infra/persistence/mikro-orm-outbox-store';
import { SqsEventPublisher } from './infra/sqs/sqs-event-publisher';
import { QUEUE_URLS, QueueUrls, SQS_CLIENT, createSqsClient } from './infra/sqs/sqs';

@Injectable()
class SqsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

@Global()
@Module({
  providers: [
    { provide: SQS_CLIENT, inject: [ENV], useFactory: (env: Env) => createSqsClient(env) },
    {
      provide: QUEUE_URLS,
      inject: [SQS_CLIENT],
      useFactory: (sqs: SQSClient) => new QueueUrls(sqs),
    },
    {
      provide: OUTBOX_STORE,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmOutboxStore(orm),
    },
    {
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT, QUEUE_URLS, ENV],
      useFactory: (sqs: SQSClient, queues: QueueUrls, env: Env) =>
        new SqsEventPublisher(sqs, queues, env.SQS_EVENTS_QUEUE_NAME),
    },
    {
      provide: OUTBOX_RELAY,
      inject: [OUTBOX_STORE, EVENT_PUBLISHER, CLOCK, ENV],
      useFactory: (store: OutboxStore, publisher: EventPublisher, clock: Clock, env: Env) =>
        new OutboxRelay(store, publisher, clock, {
          batchSize: env.OUTBOX_BATCH_SIZE,
          backoff: { baseMs: env.OUTBOX_RETRY_BASE_MS, maxMs: env.OUTBOX_RETRY_MAX_MS },
        }),
    },
    OutboxPublisherWorker,
    MessagingGauges,
    SqsLifecycle,
  ],
  exports: [SQS_CLIENT, QUEUE_URLS, OUTBOX_STORE],
})
export class MessagingModule {}
