import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvariantViolationError,
} from '../../../src/shared/domain/errors';
import { Money } from '../../../src/shared/domain/money';
import { LedgerDirection } from '../../../src/modules/wallet/domain/ledger-direction';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { WalletLedgerEntry } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { brl, openWallet, T0, usd } from '../../support/fixtures';

const T1 = new Date('2026-07-29T15:01:00.000Z');
const move = (money: Money, n = 1) => ({
  entryId: `e-${String(n)}`,
  transactionId: `t-${String(n)}`,
  money,
  at: T1,
});

describe('Wallet.open', () => {
  it('starts at version 1 with an OPENING credit entry when balance > 0', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('1000.00'),
      openingTransactionId: 'otx',
      openingEntryId: 'oe',
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.transactionId).toBe('otx');
  });

  it('has no ledger entry when the initial balance is zero', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: Money.zero('BRL'),
      openingTransactionId: 'otx',
      openingEntryId: 'oe',
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('1.00').negate(),
        openingTransactionId: 'otx',
        openingEntryId: 'oe',
        at: T0,
      }),
    ).toThrow(InvalidMoneyError);
  });
});

describe('Wallet movements', () => {
  it('debit decreases balance, bumps version and returns a balanced DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(move(brl('80.00')));
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it('credit increases balance and bumps version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(move(brl('50.00')));
    expect(wallet.balance.amount).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('allows debiting the whole balance down to zero', () => {
    const wallet = openWallet('100.00');
    wallet.debit(move(brl('100.00')));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('never goes negative: insufficient debit throws and leaves state untouched', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(move(brl('100.01')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('two 80.00 debits on 100.00: the second one fails', () => {
    const wallet = openWallet('100.00');
    wallet.debit(move(brl('80.00'), 1));
    expect(wallet.canDebit(brl('80.00'))).toBe(false);
    expect(() => wallet.debit(move(brl('80.00'), 2))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('rejects zero or negative movement amounts', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(move(Money.zero('BRL')))).toThrow(InvalidMoneyError);
    expect(() => wallet.credit(move(brl('1.00').negate()))).toThrow(InvalidMoneyError);
    expect(wallet.version).toBe(1);
  });

  it('rejects operations in another currency', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(move(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(move(usd('1.00')))).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  it('balance always equals the sum of its ledger entries', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('100.00'),
      openingTransactionId: 'otx',
      openingEntryId: 'oe',
      at: T0,
    });
    const entries = [
      openingEntry,
      wallet.debit(move(brl('30.00'), 1)),
      wallet.credit(move(brl('12.34'), 2)),
      wallet.debit(move(brl('0.01'), 3)),
    ].filter((e): e is WalletLedgerEntry => e !== undefined);
    const fromLedger = entries.reduce((sum, e) => sum.add(e.signedAmount), Money.zero('BRL'));
    expect(fromLedger.equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
  });
});

describe('WalletLedgerEntry.create', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    walletVersion: 2,
    createdAt: T0,
  };

  it('accepts a balanced entry', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  it('rejects unbalanced arithmetic', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('41.00') })).toThrow(
      InvariantViolationError,
    );
  });

  it('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(InvariantViolationError);
  });

  it('rejects zero amount and invalid version', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, money: brl('0'), balanceAfter: brl('50.00') }),
    ).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...base, walletVersion: 0 })).toThrow(
      InvariantViolationError,
    );
  });

  it('rejects mixed currencies', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: usd('10.00') })).toThrow(
      CurrencyMismatchError,
    );
  });

  it('is structurally immutable (no setters, frozen-by-design fields)', () => {
    const entry = WalletLedgerEntry.create(base);
    const proto = Object.getOwnPropertyNames(WalletLedgerEntry.prototype);
    expect(proto.filter((n) => !['constructor', 'isBalanced', 'signedAmount'].includes(n))).toEqual(
      [],
    );
    expect(entry.balanceAfter.amount).toBe('40.00');
  });
});
