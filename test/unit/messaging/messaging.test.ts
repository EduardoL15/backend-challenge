import { describe, expect, it } from 'bun:test';
import { computeBackoffMs } from '../../../src/shared/domain/backoff';
import { LedgerDirection } from '../../../src/modules/wallet/domain/ledger-direction';
import { InvalidTransactionStateError } from '../../../src/shared/domain/errors';
import { InboxMessage } from '../../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../../src/modules/wallet/domain/events/wallet-balance-changed';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/modules/wagering/domain/events/wagering-events';
import { WagerTransactionKind as Kind } from '../../../src/modules/wagering/domain/wager-transaction-kind';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import { apply, brl, openWallet, T0, wagerTx } from '../../support/fixtures';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: T0 };

describe('computeBackoffMs', () => {
  const opts = { baseMs: 1000, maxMs: 128_000 };
  it('grows exponentially and is capped', () => {
    expect(computeBackoffMs(1, { ...opts, random: () => 0.999999 })).toBe(1000);
    expect(computeBackoffMs(4, { ...opts, random: () => 0.999999 })).toBe(8000);
    expect(computeBackoffMs(30, { ...opts, random: () => 0.999999 })).toBe(128_000);
  });
  it('applies equal jitter (at least half of the delay)', () => {
    expect(computeBackoffMs(4, { ...opts, random: () => 0 })).toBe(4000);
  });
});

describe('InboxMessage', () => {
  it('is received unprocessed and can be marked processed once', () => {
    const msg = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'wager-consumer',
      payloadHash: 'h',
      at: T0,
    });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(T0);
    expect(msg.isProcessed()).toBe(true);
    expect(() => {
      msg.markProcessed(T0);
    }).toThrow(InvalidTransactionStateError);
  });
});

describe('OutboxMessage', () => {
  const wallet = openWallet('100.00');
  const entry = wallet.debit({ entryId: 'e', transactionId: 't', money: brl('10.00'), at: T0 });
  const event = WalletBalanceChanged.from(wallet, entry, ctx);

  it('enqueue uses the eventId as id and stores the serialized envelope', () => {
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe('evt-1');
    expect(msg.aggregateId).toBe(wallet.id);
    expect(msg.eventType).toBe('WalletBalanceChanged');
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
    expect(msg.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
  });

  it('scheduleRetry increments attempts and pushes nextAttemptAt forward', () => {
    const msg = OutboxMessage.enqueue(event);
    msg.scheduleRetry(T0, { baseMs: 1000, maxMs: 60_000, random: () => 0 });
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(T0)).toBe(false);
    expect(msg.isDue(new Date(T0.getTime() + 500))).toBe(true);
  });

  it('markPublished is final', () => {
    const msg = OutboxMessage.enqueue(event);
    msg.markPublished(T0);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(T0)).toBe(false);
    expect(() => {
      msg.markPublished(T0);
    }).toThrow(InvalidTransactionStateError);
    expect(() => {
      msg.scheduleRetry(T0);
    }).toThrow(InvalidTransactionStateError);
  });
});

describe('IntegrationEvent envelopes', () => {
  it('WalletBalanceChanged carries MoneyProps (strings), never Money instances', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({ entryId: 'e', transactionId: 't', money: brl('10.00'), at: T0 });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: T0.toISOString(),
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 't',
        direction: LedgerDirection.Debit,
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    // Round-trips through JSON unchanged (stable, versionable payload).
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('WagerTransactionProcessed / Rejected expose status data', () => {
    const wallet = openWallet('10.00');
    const ok = wagerTx(Kind.Bet, '5.00');
    apply(ok, wallet);
    const processed = WagerTransactionProcessed.from(ok, ctx).toJSON();
    expect(processed.eventType).toBe('WagerTransactionProcessed');
    expect(processed.data.balance).toEqual({ amount: '5.00', currency: 'BRL' });

    const ko = wagerTx(Kind.Bet, '50.00');
    apply(ko, wallet);
    const rejected = WagerTransactionRejected.from(ko, ctx).toJSON();
    expect(rejected.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});
