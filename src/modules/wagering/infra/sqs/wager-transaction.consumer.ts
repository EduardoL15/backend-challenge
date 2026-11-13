import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ENV, type Env } from '../../../../config/env';
import {
  ConflictError,
  InboxPayloadMismatchError,
  NotFoundError,
  TransientInfrastructureError,
  ValidationError,
} from '../../../../shared/application/errors';
import type { ExecutionContext } from '../../../../shared/application/ports';
import { DomainError } from '../../../../shared/domain/errors';
import { FailureCode } from '../../../../shared/domain/failure-code';
import {
  type AppMetrics,
  type ConsumerOutcome,
  METRICS,
} from '../../../../shared/application/metrics';
import { addContext, withContext } from '../../../../observability/context';
import { inSpan, setSpanAttributes } from '../../../../observability/tracing';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../../../messaging/infra/sqs/sqs';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../domain/wager-transaction-kind';
import { PermanentMessageError, messageHash, parseWagerMessage } from './wager-message';

type ErrorClass = 'business' | 'transient' | 'permanent';

const CONTRACT_CODES = new Set<string>([
  FailureCode.InvalidPayload,
  FailureCode.InvalidAmount,
  FailureCode.InternalKindNotAllowed,
]);

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Error taxonomy for queue input:
 *  - business  (terminal): conflict, unknown wallet, business rule -> ACK, never retried
 *  - permanent (poison):   malformed JSON/envelope/payload, inbox payload mismatch -> DLQ now
 *  - transient:            lock timeout, DB/network down, and any UNKNOWN error -> retry with
 *                          backoff (visibility); the queue's redrive policy moves it to the DLQ
 *                          after maxReceiveCount receives.
 */
export function classifyError(error: unknown): ErrorClass {
  if (error instanceof PermanentMessageError) return 'permanent';
  if (error instanceof InboxPayloadMismatchError) return 'permanent';
  if (error instanceof ValidationError) return 'permanent';
  if (error instanceof DomainError) {
    return CONTRACT_CODES.has(error.code) ? 'permanent' : 'business';
  }
  if (error instanceof ConflictError || error instanceof NotFoundError) return 'business';
  if (error instanceof TransientInfrastructureError) return 'transient';
  return 'transient';
}

@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('WagerTransactionConsumer');
  private stopping = false;
  private loop: Promise<void> | undefined;
  private readonly pollAbort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
    @Inject(METRICS) private readonly metrics: AppMetrics,
    private readonly processWager: ProcessWagerTransactionUseCase,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.APP_ROLES.includes('consumer')) return;
    this.loop = this.pollLoop();
    this.logger.log(`Consuming ${this.env.SQS_WAGER_QUEUE_NAME} as ${this.env.SQS_CONSUMER_NAME}`);
  }

  /**
   * SIGTERM: stop polling, let in-flight messages finish (bounded by SHUTDOWN_GRACE_MS) and
   * give back the ones that were received but not started. Runs BEFORE the DB pool closes.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    this.stopping = true;
    this.pollAbort.abort();
    const finished = await Promise.race([
      this.loop.then(() => true),
      sleep(this.env.SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (finished) {
      this.logger.log('Consumer stopped gracefully');
    } else {
      // Not acked => redelivered after the visibility timeout; inbox + atomic commit keep it safe.
      this.logger.warn(
        `Grace period elapsed with ${String(this.inFlight.size)} message(s) in flight`,
      );
    }
  }

  /** Method (not a field read) so TS does not narrow it: shutdown flips it concurrently. */
  private isStopping(): boolean {
    return this.stopping;
  }

  private async pollLoop(): Promise<void> {
    let queueUrl: string | undefined;
    let failures = 0;
    while (!this.stopping) {
      try {
        queueUrl ??= await this.queues.get(this.env.SQS_WAGER_QUEUE_NAME);
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: this.env.SQS_MAX_MESSAGES,
            WaitTimeSeconds: this.env.SQS_WAIT_TIME_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.pollAbort.signal },
        );
        failures = 0;
        await this.processBatch(queueUrl, response.Messages ?? []);
      } catch (error) {
        if (this.isStopping()) break; // shutdown aborted the long poll
        failures++;
        const delay = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
        this.logger.warn({
          msg: 'SQS receive failed, backing off',
          delayMs: delay,
          error: String(error),
        });
        await sleep(delay);
      }
    }
  }

  /** FIFO: messages of one group (wallet) in order; different groups in parallel. */
  private async processBatch(queueUrl: string, messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) {
            await this.release(queueUrl, message);
            continue;
          }
          const work = this.handle(queueUrl, message);
          this.inFlight.add(work);
          try {
            await work;
          } finally {
            this.inFlight.delete(work);
          }
        }
      }),
    );
  }

  /** One diagnostic context + one consumer span per message: every log line inside carries ids. */
  private handle(queueUrl: string, message: Message): Promise<void> {
    return withContext({ sqsMessageId: message.MessageId }, () =>
      inSpan(
        'sqs.process wager-transactions',
        { 'messaging.system': 'aws_sqs', 'messaging.message.id': message.MessageId ?? '' },
        () => this.handleInContext(queueUrl, message),
      ),
    );
  }

  private async handleInContext(queueUrl: string, message: Message): Promise<void> {
    const started = performance.now();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let outcome: ConsumerOutcome;

    try {
      const parsed = parseWagerMessage(message.Body);
      const ctx = this.contextFor(message, parsed.messageId);
      addContext({
        messageId: parsed.messageId,
        correlationId: ctx.correlationId,
        walletId: parsed.data.walletId,
        providerId: parsed.data.providerId,
      });
      const execution = await this.processWager.executeFromMessage(parsed.data, ctx, {
        consumerName: this.env.SQS_CONSUMER_NAME,
        messageId: parsed.messageId,
        payloadHash: messageHash(parsed),
      });
      // ACK only now: the SQL transaction (inbox + effects + outbox) is committed.
      this.crashIfFaultInjected(parsed.messageId);
      await this.ack(queueUrl, message);
      outcome = outcomeOf(execution);
      this.logger.log({ msg: 'Message handled', receiveCount, outcome });
    } catch (error) {
      outcome = await this.onFailure(queueUrl, message, receiveCount, error);
    }
    setSpanAttributes({ 'wagering.outcome': outcome });
    this.metrics.consumerMessage(outcome, performance.now() - started);
  }

  private async onFailure(
    queueUrl: string,
    message: Message,
    receiveCount: number,
    error: unknown,
  ): Promise<ConsumerOutcome> {
    const errorClass = classifyError(error);
    const detail = {
      sqsMessageId: message.MessageId,
      receiveCount,
      errorClass,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
    switch (errorClass) {
      case 'business':
        this.logger.warn({ msg: 'Business error, message acknowledged', ...detail });
        await this.ack(queueUrl, message);
        return 'business_error';
      case 'permanent':
        this.logger.error({ msg: 'Poison message, sending to DLQ', ...detail });
        await this.deadLetter(queueUrl, message, error);
        this.metrics.deadLettered(
          error instanceof PermanentMessageError ? error.reason : errorCode(error),
        );
        return 'dead_letter';
      case 'transient': {
        const delaySeconds = Math.min(
          this.env.SQS_RETRY_MAX_SECONDS,
          this.env.SQS_RETRY_BASE_SECONDS * 2 ** Math.max(0, receiveCount - 1),
        );
        const exhausted = receiveCount >= this.env.SQS_MAX_RECEIVE_COUNT;
        this.logger.warn({
          msg: exhausted
            ? 'Transient error on last attempt; the redrive policy will move it to the DLQ'
            : 'Transient error, retrying later',
          ...detail,
          retryInSeconds: delaySeconds,
        });
        await this.changeVisibility(queueUrl, message, delaySeconds);
        this.metrics.consumerRetry();
        // The queue itself moves it on the next receive; count it here, where we know why.
        if (exhausted) this.metrics.deadLettered('max_receive_count');
        return 'retry';
      }
    }
  }

  /**
   * Chaos test hook (env-validated: never enabled in production). Simulates the worst moment
   * for a consumer to die: effects COMMITTED, message NOT acknowledged.
   */
  private crashIfFaultInjected(messageId: string): void {
    if (this.env.FAULT_CRASH_AFTER_COMMIT_MESSAGE_ID !== messageId) return;
    this.logger.error({ msg: 'FAULT INJECTION: killing process after commit, before ack' });
    process.kill(process.pid, 'SIGKILL');
  }

  private contextFor(message: Message, messageId: string): ExecutionContext {
    const attr = message.MessageAttributes?.correlationId?.StringValue;
    return {
      correlationId: attr !== undefined && SAFE_ID.test(attr) ? attr : messageId,
      causationId: messageId,
    };
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    } catch (error) {
      // Already committed: a redelivery will be recognised by the inbox. Never re-applied.
      this.logger.warn({
        msg: 'Ack failed after commit',
        sqsMessageId: message.MessageId,
        error: String(error),
      });
    }
  }

  private async changeVisibility(
    queueUrl: string,
    message: Message,
    seconds: number,
  ): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.warn({
        msg: 'ChangeMessageVisibility failed',
        sqsMessageId: message.MessageId,
        error: String(error),
      });
    }
  }

  /** Received during shutdown but never started: make it visible again right away. */
  private async release(queueUrl: string, message: Message): Promise<void> {
    await this.changeVisibility(queueUrl, message, 0);
  }

  private async deadLetter(queueUrl: string, message: Message, error: unknown): Promise<void> {
    const reason = error instanceof PermanentMessageError ? error.reason : errorCode(error);
    try {
      const dlqUrl = await this.queues.get(this.env.SQS_WAGER_DLQ_NAME);
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
          MessageDeduplicationId: message.MessageId ?? `dlq-${String(Date.now())}`,
          MessageAttributes: {
            dlqReason: { DataType: 'String', StringValue: reason },
            dlqError: {
              DataType: 'String',
              StringValue: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
            },
            originalSqsMessageId: {
              DataType: 'String',
              StringValue: message.MessageId ?? 'unknown',
            },
          },
        }),
      );
    } catch (sendError) {
      // Could not park it: keep it in the main queue (retried, then redriven). Never lost.
      this.logger.error({
        msg: 'DLQ send failed, message kept for redelivery',
        error: String(sendError),
      });
      return;
    }
    await this.ack(queueUrl, message);
  }
}

function outcomeOf(
  execution: Awaited<ReturnType<ProcessWagerTransactionUseCase['executeFromMessage']>>,
): ConsumerOutcome {
  if (execution.kind === 'duplicate_message') return 'duplicate';
  switch (execution.result.status) {
    case WagerTransactionStatus.Processed:
      return execution.result.idempotentReplay ? 'duplicate' : 'processed';
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 'rejected';
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 'pending_reference';
  }
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}
