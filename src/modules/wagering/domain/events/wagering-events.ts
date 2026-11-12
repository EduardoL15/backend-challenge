import type { FailureCode } from '../../../../shared/domain/failure-code';
import { type EventContext, IntegrationEvent } from '../../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { WagerTransaction } from '../wager-transaction';
import type { WagerTransactionKind } from '../wager-transaction-kind';

interface WagerTransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function baseData(tx: WagerTransaction): WagerTransactionEventBase {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
}

function balanceOf(tx: WagerTransaction): MoneyProps {
  if (!tx.resultBalance) {
    throw new Error(`Transaction ${tx.id} has no result balance`);
  }
  return tx.resultBalance.toJSON();
}

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, including LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        ...(tx.referenceTransactionId !== undefined
          ? { referenceTransactionId: tx.referenceTransactionId }
          : {}),
        balance: balanceOf(tx),
        processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error(`Transaction ${tx.id} has no failure code`);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...baseData(tx), failureCode: tx.failureCode, balance: balanceOf(tx) },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  attempt: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.nextReferenceAttemptAt) throw new Error(`Transaction ${tx.id} is not pending`);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        attempt: tx.referenceAttempts,
        nextAttemptAt: tx.nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}
