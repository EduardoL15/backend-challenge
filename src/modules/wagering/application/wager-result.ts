import type { FailureCode } from '../../../shared/domain/failure-code';
import type { MoneyProps } from '../../../shared/domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionStatus } from '../domain/wager-transaction-kind';

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Wallet balance observed when the transaction was resolved (the ORIGINAL one on replays). */
  balance: MoneyProps | undefined;
  idempotentReplay: boolean;
  failureCode: FailureCode | undefined;
  nextAttemptAt: string | undefined;
}

export function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultBalance?.toJSON(),
    idempotentReplay,
    failureCode: tx.failureCode,
    nextAttemptAt: tx.nextReferenceAttemptAt?.toISOString(),
  };
}
