import { createHash } from 'node:crypto';
import { canonicalJson } from '../../domain/payload-hash';
import { type WagerMessage, wagerMessageSchema } from '../../application/wager-contract';

/** The message can never succeed (bad JSON, bad envelope, bad payload): goes to the DLQ. */
export class PermanentMessageError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

export function parseWagerMessage(body: string | undefined): WagerMessage {
  if (body === undefined || body === '') {
    throw new PermanentMessageError('EMPTY_BODY', 'Message body is empty');
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new PermanentMessageError('MALFORMED_JSON', 'Message body is not valid JSON');
  }
  const parsed = wagerMessageSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new PermanentMessageError('INVALID_ENVELOPE', `Invalid message: ${detail}`);
  }
  return parsed.data;
}

/** Hash of the whole (canonical) envelope: detects a reused messageId with another body. */
export function messageHash(message: WagerMessage): string {
  return createHash('sha256').update(canonicalJson(message)).digest('hex');
}
