import { describe, expect, it } from 'bun:test';
import {
  ConflictError,
  InboxPayloadMismatchError,
  NotFoundError,
  TransientInfrastructureError,
} from '../../../src/shared/application/errors';
import { DomainError } from '../../../src/shared/domain/errors';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import {
  PermanentMessageError,
  messageHash,
  parseWagerMessage,
} from '../../../src/modules/wagering/infra/sqs/wager-message';
import { classifyError } from '../../../src/modules/wagering/infra/sqs/wager-transaction.consumer';

const valid = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

const reasonOf = (body: string | undefined): string | undefined => {
  try {
    parseWagerMessage(body);
  } catch (e) {
    return e instanceof PermanentMessageError ? e.reason : 'other';
  }
  return undefined;
};

describe('parseWagerMessage', () => {
  it('accepts the envelope from the challenge', () => {
    expect(parseWagerMessage(JSON.stringify(valid)).data.idempotencyKey).toBe(
      'provider-a:transaction-123',
    );
  });

  it.each([
    ['empty body', '', 'EMPTY_BODY'],
    ['undefined body', undefined, 'EMPTY_BODY'],
    ['malformed JSON', '{oops', 'MALFORMED_JSON'],
    ['wrong type', JSON.stringify({ ...valid, type: 'Other' }), 'INVALID_ENVELOPE'],
    [
      'missing idempotencyKey',
      JSON.stringify({ ...valid, data: { ...valid.data, idempotencyKey: undefined } }),
      'INVALID_ENVELOPE',
    ],
    [
      'numeric amount',
      JSON.stringify({ ...valid, data: { ...valid.data, money: { amount: 25, currency: 'BRL' } } }),
      'INVALID_ENVELOPE',
    ],
    ['unknown field', JSON.stringify({ ...valid, extra: true }), 'INVALID_ENVELOPE'],
  ])('%s -> %s', (_label, body, reason) => {
    expect(reasonOf(body)).toBe(reason);
  });

  it('messageHash is stable and sensitive to the body', () => {
    const a = parseWagerMessage(JSON.stringify(valid));
    const b = parseWagerMessage(JSON.stringify({ ...valid }));
    const c = parseWagerMessage(
      JSON.stringify({
        ...valid,
        data: { ...valid.data, money: { amount: '26.00', currency: 'BRL' } },
      }),
    );
    expect(messageHash(a)).toBe(messageHash(b));
    expect(messageHash(a)).not.toBe(messageHash(c));
  });
});

describe('classifyError (consumer error taxonomy)', () => {
  it.each([
    ['poison body', new PermanentMessageError('MALFORMED_JSON', 'x'), 'permanent'],
    ['inbox payload mismatch', new InboxPayloadMismatchError('m'), 'permanent'],
    ['invalid amount', new DomainError(FailureCode.InvalidAmount, 'x'), 'permanent'],
    ['OPENING submitted', new DomainError(FailureCode.InternalKindNotAllowed, 'x'), 'permanent'],
    ['idempotency conflict', new ConflictError('IDEMPOTENCY_CONFLICT', 'x'), 'business'],
    ['unknown wallet', new NotFoundError('WALLET_NOT_FOUND', 'x'), 'business'],
    ['lock timeout', new TransientInfrastructureError('x'), 'transient'],
    ['unknown bug', new Error('boom'), 'transient'],
  ])('%s -> %s', (_label, error, expected) => {
    expect(classifyError(error) as string).toBe(expected);
  });
});
