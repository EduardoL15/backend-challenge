import { DomainError, InvalidTransactionStateError } from '../../../shared/domain/errors';
import { FailureCode } from '../../../shared/domain/failure-code';
import { Money } from '../../../shared/domain/money';
import { LedgerDirection, oppositeDirection } from '../../wallet/domain/ledger-direction';
import {
  ALLOWED_REFERENCE_KINDS,
  REVERSAL_KINDS,
  TERMINAL_STATUSES,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction-kind';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  at: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'at'> {
  createdAt: Date;
  updatedAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Wallet balance observed when the transaction reached its current state (for replays). */
  resultBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
}

export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Valid transitions:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PENDING_REFERENCE (retry scheduled) | PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED are terminal: any transition throws InvalidTransactionStateError.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Id at the provider, not the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _updatedAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Born PENDING. Validates the contract-level rules for the kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError(
        FailureCode.InternalKindNotAllowed,
        'OPENING is internal and cannot be submitted',
      );
    }
    WagerTransaction.assertNonEmpty(props);

    const reference = props.referenceExternalTransactionId;
    const allowedReferenceKinds = ALLOWED_REFERENCE_KINDS[props.kind];
    if (REVERSAL_KINDS.has(props.kind) && !reference) {
      throw new DomainError(
        FailureCode.InvalidPayload,
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (reference !== undefined && allowedReferenceKinds === undefined) {
      throw new DomainError(
        FailureCode.InvalidPayload,
        `${props.kind} cannot carry referenceExternalTransactionId`,
      );
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new DomainError(FailureCode.InvalidPayload, 'A transaction cannot reference itself');
    }

    const amountOk =
      props.kind === WagerTransactionKind.Loss
        ? !props.money.isNegative()
        : props.money.isPositive();
    if (!amountOk) {
      throw new DomainError(
        FailureCode.InvalidAmount,
        `${props.kind} amount must be ${props.kind === WagerTransactionKind.Loss ? '>= 0' : '> 0'}`,
      );
    }

    return WagerTransaction.newPending(props);
  }

  /** Internal OPENING credit created together with the wallet. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    const key = `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`;
    return WagerTransaction.newPending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: key,
      payloadHash: key,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: INTERNAL_PROVIDER_ID,
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      at: props.at,
    });
  }

  /** Reconstruction from persistence. Does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.updatedAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.at,
      props.at,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  // ---- getters

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date, balance: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = balance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  /** Counts one more attempt to resolve the reference and schedules the next one. */
  markPendingReference(nextAttemptAt: Date, at: Date, balance: Money): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
    this._resultBalance = balance;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, balance: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = balance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference || reference.kind === WagerTransactionKind.Rollback) {
          throw new InvalidTransactionStateError('ROLLBACK needs a non-ROLLBACK reference');
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move the balance');
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${transition} transaction ${this.id}: status ${this._status} is terminal`,
      );
    }
  }

  private static assertNonEmpty(props: CreateWagerTransactionProps): void {
    const required = {
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (value.trim() === '') {
        throw new DomainError(FailureCode.InvalidPayload, `${field} is required`);
      }
    }
    if (props.referenceExternalTransactionId?.trim() === '') {
      throw new DomainError(FailureCode.InvalidPayload, 'referenceExternalTransactionId is empty');
    }
  }
}
