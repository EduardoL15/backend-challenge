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

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.url().optional(),
  SQS_WAGER_QUEUE_NAME: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().default('wagering-events.fifo'),
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
