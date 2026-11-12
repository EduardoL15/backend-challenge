import { InvariantViolationError } from '../../../shared/domain/errors';
import { FailureCode } from '../../../shared/domain/failure-code';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { WagerTransaction } from './wager-transaction';
import {
  ALLOWED_REFERENCE_KINDS,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction-kind';

export interface ApplyWagerTransactionInput {
  transaction: WagerTransaction;
  /** Must be locked by the caller (SELECT ... FOR UPDATE) for the whole transaction. */
  wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when absent. */
  reference: WagerTransaction | undefined;
  /** True when the reference already has a PROCESSED reversal (REFUND or ROLLBACK). */
  referenceAlreadyReversed: boolean;
  entryId: string;
  at: Date;
  maxReferenceAttempts: number;
  /** Computes when to retry, given the 1-based attempt number about to be recorded. */
  scheduleReferenceRetry: (attempt: number, now: Date) => Date;
}

export type WagerOutcome =
  | { type: 'processed'; entry: WalletLedgerEntry | undefined }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending_reference' };

/**
 * Applies a non-terminal wager transaction to a wallet, enforcing the business rules.
 * Mutates the transaction (state) and the wallet (balance) consistently.
 * Business-rule violations become a REJECTED transaction, never an exception.
 *
 * Interpretation: a reference can be reversed at most ONCE in total (REFUND or ROLLBACK),
 * otherwise a BET refunded and then rolled back would be credited twice.
 * Undoing a REFUND is done with a ROLLBACK that references the REFUND itself.
 */
export function applyWagerTransaction(input: ApplyWagerTransactionInput): WagerOutcome {
  const { transaction: tx, wallet, reference, at } = input;

  if (tx.isTerminal()) {
    throw new InvariantViolationError(`Transaction ${tx.id} is already ${tx.status}`);
  }

  const reject = (code: FailureCode): WagerOutcome => {
    tx.reject(code, at, wallet.balance);
    return { type: 'rejected', code };
  };

  if (tx.walletId !== wallet.id || tx.playerId !== wallet.playerId) {
    return reject(FailureCode.PlayerWalletMismatch);
  }
  if (tx.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (tx.referenceExternalTransactionId !== undefined) {
    const waitOrGiveUp = (codeWhenExhausted: FailureCode): WagerOutcome => {
      if (tx.referenceAttempts >= input.maxReferenceAttempts) {
        return reject(codeWhenExhausted);
      }
      const attempt = tx.referenceAttempts + 1;
      tx.markPendingReference(input.scheduleReferenceRetry(attempt, at), at, wallet.balance);
      return { type: 'pending_reference' };
    };

    if (!reference) {
      return waitOrGiveUp(FailureCode.ReferenceNotFound);
    }

    const referenceCode = validateReference(tx, reference);
    if (referenceCode) return reject(referenceCode);

    // Reference exists but is still being processed: wait for it.
    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return waitOrGiveUp(FailureCode.ReferenceNotProcessed);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }

    if (tx.isReversal()) {
      if (!tx.money.equals(reference.money)) {
        return reject(FailureCode.ReversalAmountMismatch);
      }
      if (input.referenceAlreadyReversed) {
        return reject(FailureCode.ReferenceAlreadyReversed);
      }
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, at, wallet.balance);
    return { type: 'processed', entry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const movement = { entryId: input.entryId, transactionId: tx.id, money: tx.money, at };

  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(
      tx.kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalInsufficientFunds,
    );
  }

  const entry =
    direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  tx.markProcessed(reference?.id, at, wallet.balance);
  return { type: 'processed', entry };
}

/** Same provider, player, wallet, currency and round; allowed kind. */
function validateReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
): FailureCode | undefined {
  const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
  if (!allowed.includes(reference.kind)) {
    return FailureCode.ReferenceKindNotAllowed;
  }
  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.roundId === tx.roundId;
  if (!sameContext) {
    return FailureCode.ReferenceMismatch;
  }
  if (reference.money.currency !== tx.money.currency) {
    // Defensive: same wallet implies same currency, but keep the rule explicit.
    return FailureCode.CurrencyMismatch;
  }
  return undefined;
}
