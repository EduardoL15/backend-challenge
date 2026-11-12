import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Used only when initialBalance > 0: id of the internal OPENING transaction. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** CREDIT entry for the OPENING transaction; undefined when the initial balance is zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. Every balance change goes through debit/credit, which return the
 * matching ledger entry, so balance and ledger can never drift apart in memory.
 * `version` starts at 1 and increments only when the balance changes.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial balance cannot be negative');
    }
    const currency = initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );
    const openingEntry = initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: initialBalance,
          walletVersion: 1,
          createdAt: props.at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence. Does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError('Movement amount must be positive');
    }
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    const nextVersion = this._version + 1;

    // Build (and validate) the entry before mutating, so a failure leaves the wallet untouched.
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: props.at,
    });

    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
