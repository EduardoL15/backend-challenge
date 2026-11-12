import { z } from 'zod';

export const APP_ROLES = ['api', 'consumer', 'outbox', 'pending'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  APP_ROLES: z
    .string()
    .default(APP_ROLES.join(','))
    .transform((raw) =>
      raw
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(APP_ROLES)).min(1)),

  DATABASE_URL: z.url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Max wait for a wallet row lock before answering 503 (retry is safe). */
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /** PENDING_REFERENCE retries: 8 attempts, 1s -> 128s exponential with jitter (~4-5 min). */
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  PENDING_REFERENCE_BASE_MS: z.coerce.number().int().positive().default(1_000),
  PENDING_REFERENCE_MAX_MS: z.coerce.number().int().positive().default(128_000),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  SQS_WAGER_QUEUE_NAME: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().default('wagering-events.fifo'),
  /** Inbox key namespace: (consumerName, messageId). */
  SQS_CONSUMER_NAME: z.string().min(1).default('wager-transactions-consumer'),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
  /** Must match the queue RedrivePolicy.maxReceiveCount (used for logs/metrics/backoff). */
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).default(5),
  SQS_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).default(2),
  SQS_RETRY_MAX_SECONDS: z.coerce.number().int().min(0).max(43_200).default(60),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
  OUTBOX_RETRY_MAX_MS: z.coerce.number().int().positive().default(60_000),

  PENDING_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  PENDING_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),

  /** Max time to finish in-flight work on SIGTERM before giving messages back. */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(25_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
