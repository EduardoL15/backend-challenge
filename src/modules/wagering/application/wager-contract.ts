import { z } from 'zod';

/**
 * Input contracts shared by every entry point (HTTP and SQS). Money stays a STRING here;
 * exact parsing happens in Money.from (never a JS number).
 */
export const moneySchema = z.strictObject({
  amount: z.string({ error: 'amount must be a decimal string, e.g. "25.00"' }),
  currency: z.string(),
});

export const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const wagerPayloadSchema = z.strictObject({
  providerId: boundedText(100),
  externalTransactionId: boundedText(200),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: boundedText(200),
  gameId: boundedText(200),
  kind: z.string().min(1).max(20),
  money: moneySchema,
  referenceExternalTransactionId: boundedText(200).optional(),
});

export const idempotencyKeySchema = z
  .string({ error: 'Idempotency-Key is required' })
  .trim()
  .min(1, 'Idempotency-Key is required')
  .max(255);

/** SQS message envelope (section 10 of the challenge). */
export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export const wagerMessageSchema = z.strictObject({
  messageId: boundedText(200),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.iso.datetime(),
  data: wagerPayloadSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
