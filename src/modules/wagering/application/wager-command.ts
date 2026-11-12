import { DomainError } from '../../../shared/domain/errors';
import { FailureCode } from '../../../shared/domain/failure-code';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { computePayloadHash } from '../domain/payload-hash';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';

/** Same shape for HTTP and SQS: both entry points call the same use case. */
export interface WagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface NormalizedWagerCommand extends Omit<WagerCommand, 'kind' | 'money'> {
  kind: WagerTransactionKind;
  money: Money;
  payloadHash: string;
}

const KINDS: readonly WagerTransactionKind[] = Object.values(WagerTransactionKind);

/**
 * Parses money (exact, fixed scale) and kind, then hashes the canonical business payload.
 * Throws DomainError (INVALID_AMOUNT / INVALID_PAYLOAD) for contract violations.
 */
export function normalizeWagerCommand(command: WagerCommand): NormalizedWagerCommand {
  const { kind: rawKind, money: rawMoney, ...rest } = command;
  const kind = KINDS.find((candidate: string) => candidate === rawKind);
  if (kind === undefined) {
    throw new DomainError(FailureCode.InvalidPayload, `Unknown kind "${rawKind}"`);
  }
  const money = Money.from(rawMoney);
  const payloadHash = computePayloadHash({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind,
    money: money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
  return { ...rest, kind, money, payloadHash };
}
