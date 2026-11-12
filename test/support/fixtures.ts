import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind';
import {
  type ApplyWagerTransactionInput,
  applyWagerTransaction,
} from '../../src/modules/wagering/domain/wagering-policy';

export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const PLAYER_ID = 'player-1';
export const WALLET_ID = 'wallet-1';
export const PROVIDER_ID = 'provider-a';

let seq = 0;
export const nextId = (prefix = 'id'): string => `${prefix}-${String(++seq)}`;

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

export function openWallet(initial = '100.00', currency = 'BRL'): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: initial, currency }),
    openingTransactionId: 'opening-tx',
    openingEntryId: 'opening-entry',
    at: T0,
  }).wallet;
}

export function wagerTx(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: 'hash',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    at: T0,
    ...overrides,
  });
}

export function apply(
  transaction: WagerTransaction,
  wallet: Wallet,
  extra: Partial<ApplyWagerTransactionInput> = {},
): ReturnType<typeof applyWagerTransaction> {
  return applyWagerTransaction({
    transaction,
    wallet,
    reference: undefined,
    referenceAlreadyReversed: false,
    entryId: nextId('entry'),
    at: T0,
    maxReferenceAttempts: 8,
    scheduleReferenceRetry: (attempt, now) => new Date(now.getTime() + attempt * 1000),
    ...extra,
  });
}

/** A BET that has already been applied to the wallet. */
export function processedBet(wallet: Wallet, amount: string): WagerTransaction {
  const bet = wagerTx(WagerTransactionKind.Bet, amount);
  const outcome = apply(bet, wallet);
  if (outcome.type !== 'processed') throw new Error('fixture BET was not processed');
  return bet;
}
