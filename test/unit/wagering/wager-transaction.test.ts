import { describe, expect, it } from 'bun:test';
import { DomainError, InvalidTransactionStateError } from '../../../src/shared/domain/errors';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import { LedgerDirection } from '../../../src/modules/wallet/domain/ledger-direction';
import { WagerTransaction } from '../../../src/modules/wagering/domain/wager-transaction';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/modules/wagering/domain/wager-transaction-kind';
import { brl, T0, wagerTx } from '../../support/fixtures';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `non-domain:${String(e)}`;
  }
  return undefined;
};

describe('WagerTransaction.create', () => {
  it('is born PENDING with zero reference attempts', () => {
    const tx = wagerTx(Kind.Bet, '25.00');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
  });

  it('refuses the internal OPENING kind', () => {
    expect(codeOf(() => wagerTx(Kind.Opening, '10.00'))).toBe(FailureCode.InternalKindNotAllowed);
  });

  it.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(codeOf(() => wagerTx(kind, '10.00'))).toBe(FailureCode.InvalidPayload);
  });

  it('BET cannot carry a reference', () => {
    expect(codeOf(() => wagerTx(Kind.Bet, '10.00', { referenceExternalTransactionId: 'x' }))).toBe(
      FailureCode.InvalidPayload,
    );
  });

  it('WIN and LOSS may optionally reference', () => {
    expect(
      wagerTx(Kind.Win, '10.00', { referenceExternalTransactionId: 'bet' })
        .referenceExternalTransactionId,
    ).toBe('bet');
    expect(wagerTx(Kind.Loss, '0.00').status).toBe(Status.Pending);
  });

  it('cannot reference itself', () => {
    expect(
      codeOf(() =>
        wagerTx(Kind.Refund, '1.00', {
          externalTransactionId: 'same',
          referenceExternalTransactionId: 'same',
        }),
      ),
    ).toBe(FailureCode.InvalidPayload);
  });

  it.each([Kind.Bet, Kind.Win, Kind.Refund])('%s rejects a zero amount', (kind) => {
    const ref = kind === Kind.Refund ? { referenceExternalTransactionId: 'b' } : {};
    expect(codeOf(() => wagerTx(kind, '0.00', ref))).toBe(FailureCode.InvalidAmount);
  });

  it('rejects empty required fields', () => {
    expect(codeOf(() => wagerTx(Kind.Bet, '1.00', { roundId: '  ' }))).toBe(
      FailureCode.InvalidPayload,
    );
  });

  it('matchesPayload compares the payload hash', () => {
    const tx = wagerTx(Kind.Bet, '1.00', { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  it('createOpening builds an internal OPENING transaction', () => {
    const tx = WagerTransaction.createOpening({
      id: 'o',
      walletId: 'w',
      playerId: 'p',
      money: brl('10.00'),
      at: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction transitions', () => {
  it('PENDING -> PROCESSED stores reference, time and observed balance', () => {
    const tx = wagerTx(Kind.Bet, '1.00');
    tx.markProcessed(undefined, T0, brl('99.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(T0);
    expect(tx.resultBalance?.amount).toBe('99.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING -> PENDING_REFERENCE -> PENDING_REFERENCE -> PROCESSED counts attempts', () => {
    const tx = wagerTx(Kind.Refund, '1.00', { referenceExternalTransactionId: 'b' });
    tx.markPendingReference(new Date(T0.getTime() + 1000), T0, brl('5.00'));
    tx.markPendingReference(new Date(T0.getTime() + 3000), T0, brl('5.00'));
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(2);
    tx.markProcessed('bet-id', T0, brl('6.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('bet-id');
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  it('reject and fail store the failure code', () => {
    const rejected = wagerTx(Kind.Bet, '1.00');
    rejected.reject(FailureCode.InsufficientFunds, T0, brl('0.50'));
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const failed = wagerTx(Kind.Bet, '1.00');
    failed.fail(FailureCode.PermanentInfrastructureError, T0);
    expect(failed.status).toBe(Status.Failed);
  });

  it.each([
    [
      'PROCESSED',
      (tx: WagerTransaction) => {
        tx.markProcessed(undefined, T0, brl('1.00'));
      },
    ],
    [
      'REJECTED',
      (tx: WagerTransaction) => {
        tx.reject(FailureCode.InsufficientFunds, T0, brl('1'));
      },
    ],
    [
      'FAILED',
      (tx: WagerTransaction) => {
        tx.fail(FailureCode.PermanentInfrastructureError, T0);
      },
    ],
  ])('%s is terminal: every further transition throws', (_status, toTerminal) => {
    const tx = wagerTx(Kind.Bet, '1.00');
    toTerminal(tx);
    expect(() => {
      tx.markProcessed(undefined, T0, brl('1.00'));
    }).toThrow(InvalidTransactionStateError);
    expect(() => {
      tx.markPendingReference(T0, T0, brl('1.00'));
    }).toThrow(InvalidTransactionStateError);
    expect(() => {
      tx.reject(FailureCode.InsufficientFunds, T0, brl('1.00'));
    }).toThrow(InvalidTransactionStateError);
    expect(() => {
      tx.fail(FailureCode.PermanentInfrastructureError, T0);
    }).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction domain queries', () => {
  it('affectsBalance is false only for LOSS', () => {
    expect(wagerTx(Kind.Loss, '0.00').affectsBalance()).toBe(false);
    expect(wagerTx(Kind.Bet, '1.00').affectsBalance()).toBe(true);
  });

  it('requiresReference is true for REFUND and ROLLBACK', () => {
    expect(
      wagerTx(Kind.Refund, '1.00', { referenceExternalTransactionId: 'b' }).requiresReference(),
    ).toBe(true);
    expect(
      wagerTx(Kind.Rollback, '1.00', { referenceExternalTransactionId: 'b' }).requiresReference(),
    ).toBe(true);
    expect(wagerTx(Kind.Win, '1.00').requiresReference()).toBe(false);
  });

  it('ledgerDirectionFor: BET debit, WIN/REFUND credit, ROLLBACK inverts the reference', () => {
    const bet = wagerTx(Kind.Bet, '1.00');
    const win = wagerTx(Kind.Win, '1.00');
    const refund = wagerTx(Kind.Refund, '1.00', { referenceExternalTransactionId: 'b' });
    const rollback = wagerTx(Kind.Rollback, '1.00', { referenceExternalTransactionId: 'b' });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it('LOSS and an unreferenced ROLLBACK have no ledger direction', () => {
    expect(() => wagerTx(Kind.Loss, '0.00').ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      wagerTx(Kind.Rollback, '1.00', { referenceExternalTransactionId: 'b' }).ledgerDirectionFor(),
    ).toThrow(InvalidTransactionStateError);
  });
});
