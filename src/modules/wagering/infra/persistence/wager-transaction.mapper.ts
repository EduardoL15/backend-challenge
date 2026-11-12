import { FailureCode } from '../../../../shared/domain/failure-code';
import { Money } from '../../../../shared/domain/money';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction-kind';
import type { WagerTransactionRecord } from './wager-transaction.schema';

const KINDS: readonly WagerTransactionKind[] = Object.values(WagerTransactionKind);
const STATUSES: readonly WagerTransactionStatus[] = Object.values(WagerTransactionStatus);
const FAILURE_CODES: readonly FailureCode[] = Object.values(FailureCode);

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: parse(r.kind, KINDS, 'kind'),
      money: Money.from({ amount: r.amount, currency: r.currency }),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      status: parse(r.status, STATUSES, 'status'),
      referenceTransactionId: r.referenceTransactionId ?? undefined,
      failureCode:
        r.failureCode != null ? parse(r.failureCode, FAILURE_CODES, 'failure code') : undefined,
      processedAt: r.processedAt ?? undefined,
      resultBalance:
        r.resultBalance != null && r.resultBalanceCurrency != null
          ? Money.from({ amount: r.resultBalance, currency: r.resultBalanceCurrency })
          : undefined,
      referenceAttempts: r.referenceAttempts,
      nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? undefined,
    });
  },

  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      resultBalance: tx.resultBalance?.amount ?? null,
      resultBalanceCurrency: tx.resultBalance?.currency ?? null,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
      processedAt: tx.processedAt ?? null,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  },
};

/** Narrows a database string to one of the allowed enum values, or fails loudly. */
function parse<T extends string>(value: string, allowed: readonly T[], what: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`Unknown ${what} in database: ${value}`);
  return found;
}
