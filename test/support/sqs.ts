import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const SQS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: SQS_ENDPOINT,
    useQueueUrlAsEndpoint: false,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export interface TestQueues {
  mainName: string;
  dlqName: string;
  mainUrl: string;
  dlqUrl: string;
  destroy(): Promise<void>;
}

/** Fresh FIFO queue + DLQ per test file, so tests never see each other's messages. */
export async function createTestQueues(
  sqs: SQSClient,
  options: { maxReceiveCount: number; visibilityTimeoutSeconds: number },
): Promise<TestQueues> {
  const suffix = randomUUID().slice(0, 8);
  const dlqName = `test-wager-dlq-${suffix}.fifo`;
  const mainName = `test-wager-${suffix}.fifo`;
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }),
  );
  const dlqUrl = dlq.QueueUrl ?? '';
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: mainName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(options.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attrs.Attributes?.QueueArn,
          maxReceiveCount: String(options.maxReceiveCount),
        }),
      },
    }),
  );
  const mainUrl = main.QueueUrl ?? '';
  return {
    mainName,
    dlqName,
    mainUrl,
    dlqUrl,
    destroy: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: mainUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

export interface WagerEnvelopeInput {
  messageId?: string;
  walletId: string;
  playerId: string;
  externalId?: string;
  kind?: string;
  amount?: string;
  ref?: string;
}

export function wagerEnvelope(input: WagerEnvelopeInput) {
  const externalTransactionId = input.externalId ?? randomUUID();
  return {
    messageId: input.messageId ?? `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: input.kind ?? 'BET',
      money: { amount: input.amount ?? '10.00', currency: 'BRL' },
      ...(input.ref !== undefined ? { referenceExternalTransactionId: input.ref } : {}),
    },
  };
}

/**
 * Sends a raw body. A fresh MessageDeduplicationId is used on purpose: the BROKER must not
 * be the one deduplicating, the inbox must.
 */
export async function sendRaw(
  sqs: SQSClient,
  queueUrl: string,
  body: string,
  groupId: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

export async function drain(sqs: SQSClient, queueUrl: string): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
    }),
  );
  return res.Messages ?? [];
}

/**
 * Reads until at least one message shows up (bounded). A single receive is racy: under CPU
 * pressure LocalStack may make a just-sent DLQ message visible a moment later.
 */
export async function receiveAtLeastOne(
  sqs: SQSClient,
  queueUrl: string,
  timeoutMs = 15_000,
): Promise<Message[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await drain(sqs, queueUrl);
    if (messages.length > 0) return messages;
  }
  return [];
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 200, what = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for ${what}`);
}
