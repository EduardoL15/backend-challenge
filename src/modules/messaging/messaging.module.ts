import type { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { CONSUMER_METRICS, NoopConsumerMetrics } from './application/consumer-metrics';
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
    { provide: CONSUMER_METRICS, useClass: NoopConsumerMetrics },
    SqsLifecycle,
  ],
  exports: [SQS_CLIENT, QUEUE_URLS, CONSUMER_METRICS],
})
export class MessagingModule {}
