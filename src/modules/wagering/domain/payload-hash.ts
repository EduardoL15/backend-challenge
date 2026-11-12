import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../../shared/domain/money';

/** Business fields that define "the same request". Transport metadata never enters the hash. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** Must already be normalized by Money (fixed scale), so "25" and "25.00" hash equally. */
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` values dropped,
 * no whitespace. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** payloadHash = hex(SHA-256(canonicalJson(business fields))). */
export function computePayloadHash(fields: WagerPayloadFields): string {
  const subset: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(subset)).digest('hex');
}
