import { describe, expect, it } from 'bun:test';
import { InvariantViolationError } from '../../../src/shared/domain/errors';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import { Money } from '../../../src/shared/domain/money';
import { LedgerDirection } from '../../../src/modules/wallet/domain/ledger-direction';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/modules/wagering/domain/wager-transaction-kind';
import { apply, openWallet, processedBet, T0, usd, wagerTx } from '../../support/fixtures';

describe('BET', () => {
  it('debits the wallet and produces one DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const bet = wagerTx(Kind.Bet, '25.00');
    const outcome = apply(bet, wallet);
    expect(outcome.type).toBe('processed');
    if (outcome.type !== 'processed') return;
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('75.00');
    expect(bet.status).toBe(Status.Processed);
    expect(bet.resultBalance?.amount).toBe('75.00');
  });

  it('is rejected with INSUFFICIENT_FUNDS without touching the wallet', () => {
    const wallet = openWallet('10.00');
    const bet = wagerTx(Kind.Bet, '10.01');
    expect(apply(bet, wallet)).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(Status.Rejected);
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  it('mandatory scenario (sequential model): 100.00 and two 80.00 bets', () => {
    const wallet = openWallet('100.00');
    const first = apply(wagerTx(Kind.Bet, '80.00'), wallet);
    const second = apply(wagerTx(Kind.Bet, '80.00'), wallet);
    expect(first.type).toBe('processed');
    expect(second).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });
});

describe('WIN', () => {
  it('credits the wallet', () => {
    const wallet = openWallet('100.00');
    const outcome = apply(wagerTx(Kind.Win, '50.00'), wallet);
    expect(outcome.type).toBe('processed');
    expect(wallet.balance.amount).toBe('150.00');
  });

  it('can reference a BET of the same round', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const win = wagerTx(Kind.Win, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(apply(win, wallet, { reference: bet }).type).toBe('processed');
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe('120.00');
  });
});

describe('LOSS', () => {
  it('is processed without moving the balance or creating an entry', () => {
    const wallet = openWallet('100.00');
    const loss = wagerTx(Kind.Loss, '0.00');
    expect(apply(loss, wallet)).toEqual({ type: 'processed', entry: undefined });
    expect(loss.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('REFUND', () => {
  it('credits back a PROCESSED BET', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '40.00');
    const refund = wagerTx(Kind.Refund, '40.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const outcome = apply(refund, wallet, { reference: bet });
    expect(outcome.type).toBe('processed');
    expect(wallet.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  it('only references BET', () => {
    const wallet = openWallet('100.00');
    const win = wagerTx(Kind.Win, '5.00');
    apply(win, wallet);
    const refund = wagerTx(Kind.Refund, '5.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect(apply(refund, wallet, { reference: win })).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  it('must match the referenced amount (no partial reversal)', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '40.00');
    const refund = wagerTx(Kind.Refund, '39.99', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(apply(refund, wallet, { reference: bet })).toEqual({
      type: 'rejected',
      code: FailureCode.ReversalAmountMismatch,
    });
    expect(wallet.balance.amount).toBe('60.00');
  });

  it('cannot reverse the same reference twice', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '40.00');
    const refund = wagerTx(Kind.Refund, '40.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(apply(refund, wallet, { reference: bet, referenceAlreadyReversed: true })).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });

  it('rejects a reference from another round, player or provider', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '40.00');
    for (const override of [{ roundId: 'round-2' }, { providerId: 'provider-b' }]) {
      const refund = wagerTx(Kind.Refund, '40.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
        ...override,
      });
      expect(apply(refund, wallet, { reference: bet })).toEqual({
        type: 'rejected',
        code: FailureCode.ReferenceMismatch,
      });
    }
  });

  it('rejects a reference that was itself REJECTED', () => {
    const wallet = openWallet('10.00');
    const bet = wagerTx(Kind.Bet, '50.00');
    apply(bet, wallet); // rejected: insufficient funds
    const refund = wagerTx(Kind.Refund, '50.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(apply(refund, wallet, { reference: bet })).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe('ROLLBACK', () => {
  it('of a BET credits it back', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '30.00');
    const rollback = wagerTx(Kind.Rollback, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const outcome = apply(rollback, wallet, { reference: bet });
    expect(outcome.type === 'processed' && outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('of a WIN debits it back', () => {
    const wallet = openWallet('100.00');
    const win = wagerTx(Kind.Win, '50.00');
    apply(win, wallet);
    const rollback = wagerTx(Kind.Rollback, '50.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    const outcome = apply(rollback, wallet, { reference: win });
    expect(outcome.type === 'processed' && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('of a REFUND debits it back', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '30.00');
    const refund = wagerTx(Kind.Refund, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    apply(refund, wallet, { reference: bet });
    const rollback = wagerTx(Kind.Rollback, '30.00', {
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    expect(apply(rollback, wallet, { reference: refund }).type).toBe('processed');
    expect(wallet.balance.amount).toBe('70.00');
  });

  it('cannot reference a ROLLBACK or a LOSS', () => {
    const wallet = openWallet('100.00');
    const loss = wagerTx(Kind.Loss, '0.00');
    apply(loss, wallet);
    const rollback = wagerTx(Kind.Rollback, '0.01', {
      referenceExternalTransactionId: loss.externalTransactionId,
    });
    expect(apply(rollback, wallet, { reference: loss })).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  it('that would make the balance negative is rejected with a distinct code', () => {
    const wallet = openWallet('0.00');
    const win = wagerTx(Kind.Win, '50.00');
    apply(win, wallet);
    processedBet(wallet, '40.00'); // balance 10.00
    const rollback = wagerTx(Kind.Rollback, '50.00', {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect(apply(rollback, wallet, { reference: win })).toEqual({
      type: 'rejected',
      code: FailureCode.ReversalInsufficientFunds,
    });
    expect(rollback.status).toBe(Status.Rejected);
    expect(wallet.balance.amount).toBe('10.00');
  });
});

describe('out-of-order references', () => {
  it('missing reference -> PENDING_REFERENCE with a scheduled retry', () => {
    const wallet = openWallet('100.00');
    const refund = wagerTx(Kind.Refund, '10.00', { referenceExternalTransactionId: 'later' });
    expect(apply(refund, wallet)).toEqual({ type: 'pending_reference' });
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextReferenceAttemptAt).toEqual(new Date(T0.getTime() + 1000));
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('reference arrives later -> processed on retry', () => {
    const wallet = openWallet('100.00');
    const rollback = wagerTx(Kind.Rollback, '10.00', { referenceExternalTransactionId: 'bet-x' });
    apply(rollback, wallet);
    const bet = wagerTx(Kind.Bet, '10.00', { externalTransactionId: 'bet-x' });
    apply(bet, wallet);
    expect(apply(rollback, wallet, { reference: bet }).type).toBe('processed');
    expect(wallet.balance.amount).toBe('100.00');
  });

  it('reference still pending -> keeps waiting', () => {
    const wallet = openWallet('100.00');
    const bet = wagerTx(Kind.Bet, '10.00');
    const refund = wagerTx(Kind.Refund, '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(apply(refund, wallet, { reference: bet })).toEqual({ type: 'pending_reference' });
  });

  it('attempts exhausted -> REJECTED REFERENCE_NOT_FOUND', () => {
    const wallet = openWallet('100.00');
    const refund = wagerTx(Kind.Refund, '10.00', { referenceExternalTransactionId: 'never' });
    for (let i = 0; i < 3; i++) apply(refund, wallet, { maxReferenceAttempts: 3 });
    expect(refund.referenceAttempts).toBe(3);
    expect(apply(refund, wallet, { maxReferenceAttempts: 3 })).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceNotFound,
    });
    expect(refund.status).toBe(Status.Rejected);
  });
});

describe('wallet ownership and currency', () => {
  it('rejects a transaction for another player', () => {
    const wallet = openWallet('100.00');
    expect(apply(wagerTx(Kind.Bet, '1.00', { playerId: 'intruder' }), wallet)).toEqual({
      type: 'rejected',
      code: FailureCode.PlayerWalletMismatch,
    });
  });

  it('rejects a currency different from the wallet currency', () => {
    const wallet = openWallet('100.00');
    const bet = wagerTx(Kind.Bet, '1.00', { money: usd('1.00') });
    expect(apply(bet, wallet)).toEqual({ type: 'rejected', code: FailureCode.CurrencyMismatch });
    expect(wallet.balance.equals(Money.from({ amount: '100.00', currency: 'BRL' }))).toBe(true);
  });

  it('refuses to re-apply a terminal transaction (programming error)', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '1.00');
    expect(() => apply(bet, wallet)).toThrow(InvariantViolationError);
    expect(wallet.balance.amount).toBe('99.00');
  });
});
