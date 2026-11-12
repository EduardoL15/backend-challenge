import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishFailures } from '../../application/outbox-relay';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { QueueUrls } from './sqs';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes outbox messages to a FIFO queue.
 *  - MessageDeduplicationId = eventId: a re-publish after a crash is collapsed by SQS within
 *    its 5-minute window; beyond it, consumers dedupe by eventId (at-least-once contract).
 *  - MessageGroupId = walletId when the event carries one (per-wallet ordering inside the
 *    queue), else the aggregate id.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishFailures> {
    const failures: PublishFailures = new Map();
    let queueUrl: string;
    try {
      queueUrl = await this.queues.get(this.queueName);
    } catch (error) {
      for (const m of messages) failures.set(m.id, `Queue lookup failed: ${String(error)}`);
      return failures;
    }

    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      try {
        const res = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: groupIdOf(m),
              MessageDeduplicationId: m.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: m.eventType },
                eventId: { DataType: 'String', StringValue: m.id },
              },
            })),
          }),
        );
        for (const failed of res.Failed ?? []) {
          const message = chunk[Number(failed.Id)];
          if (message)
            failures.set(message.id, `${failed.Code ?? 'Error'}: ${failed.Message ?? ''}`);
        }
      } catch (error) {
        for (const m of chunk) failures.set(m.id, String(error));
      }
    }
    return failures;
  }
}

function groupIdOf(message: OutboxMessage): string {
  const data = message.payload.data;
  if (data !== null && typeof data === 'object' && 'walletId' in data) {
    const walletId: unknown = data.walletId;
    if (typeof walletId === 'string' && walletId !== '') return walletId;
  }
  return message.aggregateId;
}
