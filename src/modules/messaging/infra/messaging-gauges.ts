import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import { PrometheusMetrics } from '../../../observability/prometheus-metrics';
import { CLOCK, type Clock } from '../../../shared/application/ports';
import { OUTBOX_STORE, type OutboxStore } from '../application/outbox-relay';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from './sqs/sqs';

/**
 * Gauges computed at scrape time from the source of truth (database / SQS), so every replica
 * reports the same global value: outbox lag and backlog, and how many messages sit in the DLQ.
 */
@Injectable()
export class MessagingGauges implements OnModuleInit {
  constructor(
    private readonly metrics: PrometheusMetrics,
    @Inject(OUTBOX_STORE) private readonly outbox: OutboxStore,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.metrics.scrapeGauge(
      'wagering_outbox_lag_seconds',
      'Age of the oldest unpublished outbox event (0 when the outbox is drained)',
      async () => (await this.outbox.pendingStats(this.clock.now())).oldestAgeMs / 1000,
    );
    this.metrics.scrapeGauge(
      'wagering_outbox_pending_events',
      'Committed integration events not yet published',
      async () => (await this.outbox.pendingStats(this.clock.now())).count,
    );
    this.metrics.scrapeGauge(
      'wagering_dlq_messages',
      'Approximate number of messages waiting in the wager transactions DLQ',
      async () => {
        const queueUrl = await this.queues.get(this.env.SQS_WAGER_DLQ_NAME);
        const res = await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ['ApproximateNumberOfMessages'],
          }),
          { abortSignal: AbortSignal.timeout(2_000) },
        );
        return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0);
      },
    );
  }
}
