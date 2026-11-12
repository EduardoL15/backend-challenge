import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../../../../config/env';

export const SQS_CLIENT = Symbol('SQSClient');
export const QUEUE_URLS = Symbol('QueueUrls');

export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL !== undefined
      ? {
          endpoint: env.AWS_ENDPOINT_URL,
          // LocalStack returns queue URLs on *.localhost.localstack.cloud (127.0.0.1), which is
          // wrong from inside a container: always talk to the configured endpoint instead.
          useQueueUrlAsEndpoint: false,
        }
      : {}),
    maxAttempts: 3,
  });
}

/** Resolves queue URLs by NAME (never hard-coded URLs) and caches them. */
export class QueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  get(queueName: string): Promise<string> {
    let url = this.cache.get(queueName);
    if (!url) {
      url = this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName })).then((res) => {
        if (!res.QueueUrl) throw new Error(`Queue ${queueName} not found`);
        return res.QueueUrl;
      });
      url.catch(() => this.cache.delete(queueName));
      this.cache.set(queueName, url);
    }
    return url;
  }
}
