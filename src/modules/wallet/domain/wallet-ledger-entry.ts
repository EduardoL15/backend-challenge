import { InvariantViolationError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version right after this entry was applied. Unique per wallet in the schema. */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Immutable ledger line. No mutable fields and no transition methods:
 * immutability is structural. `create` validates the arithmetic.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.money.isPositive()) {
      throw new InvariantViolationError('Ledger entry amount must be positive');
    }
    if (entry.balanceAfter.isNegative()) {
      throw new InvariantViolationError('Ledger entry would produce a negative balance');
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvariantViolationError('Ledger entry wallet version must be >= 1');
    }
    // Comparing Money also asserts that all three amounts share the same currency.
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `Unbalanced ledger entry: ${entry.balanceBefore.toString()} ${entry.direction} ${entry.money.toString()} != ${entry.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** The signed effect of this entry on the balance (+credit / -debit). */
  get signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedAmount).equals(this.balanceAfter);
  }
}
