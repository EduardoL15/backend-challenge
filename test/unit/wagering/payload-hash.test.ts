import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/shared/domain/money';
import {
  canonicalJson,
  computePayloadHash,
  type WagerPayloadFields,
} from '../../../src/modules/wagering/domain/payload-hash';

const base: WagerPayloadFields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p',
  walletId: 'w',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: Money.from({ amount: '25.00', currency: 'BRL' }).toJSON(),
};

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('computePayloadHash (idempotency)', () => {
  it('is a stable SHA-256 hex digest', () => {
    expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash(base)).toBe(computePayloadHash({ ...base }));
  });

  it('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as WagerPayloadFields;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  it('treats "25" and "25.00" as the same request once normalized by Money', () => {
    const normalized = Money.from({ amount: '25', currency: 'BRL' }).toJSON();
    expect(computePayloadHash({ ...base, money: normalized })).toBe(computePayloadHash(base));
  });

  it('ignores fields outside the business subset (transport metadata)', () => {
    const withExtra = { ...base, idempotencyKey: 'x', messageId: 'm' } as WagerPayloadFields;
    expect(computePayloadHash(withExtra)).toBe(computePayloadHash(base));
  });

  it.each([
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: 'WIN' }],
    ['roundId', { roundId: 'round-988' }],
    ['walletId', { walletId: 'w2' }],
    ['reference', { referenceExternalTransactionId: 'bet-1' }],
  ])('same key with a different %s produces a different hash (conflict)', (_f, change) => {
    expect(computePayloadHash({ ...base, ...change })).not.toBe(computePayloadHash(base));
  });
});
