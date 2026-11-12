import { Inject, Injectable } from '@nestjs/common';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../wallet/domain/events/wallet-balance-changed';
import {
  ConflictError,
  ErrorCodes,
  NotFoundError,
  UniqueViolationError,
} from '../../../shared/application/errors';
import { eventContextFactory } from '../../../shared/application/event-context';
import {
  CLOCK,
  type Clock,
  type ExecutionContext,
  ID_GENERATOR,
  type IdGenerator,
} from '../../../shared/application/ports';
import {
  type TransactionalRepositories,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../../shared/application/unit-of-work';
import { type BackoffOptions, nextAttemptAt } from '../../../shared/domain/backoff';
import type { EventContext, IntegrationEvent } from '../../../shared/domain/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wagering-events';
import { WagerTransaction } from '../domain/wager-transaction';
import { type WagerOutcome, applyWagerTransaction } from '../domain/wagering-policy';
import {
  type NormalizedWagerCommand,
  type WagerCommand,
  normalizeWagerCommand,
} from './wager-command';
import { type WagerResult, toWagerResult } from './wager-result';

export interface WageringSettings {
  maxReferenceAttempts: number;
  referenceBackoff: BackoffOptions;
}
export const WAGERING_SETTINGS = Symbol('WageringSettings');

/** Unique constraints that mean "someone else just inserted the same request": retry -> replay. */
const RACE_CONSTRAINTS = new Set(['wager_tx_idempotency_key_uq', 'wager_tx_provider_external_uq']);
const MAX_RACE_RETRIES = 2;

/**
 * The single entry point for wager transactions (HTTP and SQS).
 *
 * 1. normalize + validate (400 on contract errors, before touching the database)
 * 2. idempotency lookup WITHOUT lock: cheap replays / conflicts
 * 3. SELECT wallet FOR UPDATE -> every operation on this wallet is serialized
 * 4. idempotency lookup AGAIN under the lock (a concurrent twin may have committed meanwhile)
 * 5. resolve reference, apply business rules, persist tx + ledger + wallet + outbox atomically
 * 6. a unique violation at COMMIT (backstop) re-runs once and lands on the replay path
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WAGERING_SETTINGS) private readonly settings: WageringSettings,
  ) {}

  async execute(command: WagerCommand, ctx: ExecutionContext): Promise<WagerResult> {
    const normalized = normalizeWagerCommand(command);
    // Validate the contract before any I/O (OPENING, missing reference, amount rules...).
    this.buildTransaction(normalized);

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.uow.run((repos) => this.process(repos, normalized, ctx));
      } catch (error) {
        const isRace =
          error instanceof UniqueViolationError &&
          error.constraint !== undefined &&
          RACE_CONSTRAINTS.has(error.constraint);
        if (isRace && attempt < MAX_RACE_RETRIES) continue;
        throw error;
      }
    }
  }

  private async process(
    repos: TransactionalRepositories,
    command: NormalizedWagerCommand,
    ctx: ExecutionContext,
  ): Promise<WagerResult> {
    const known = await repos.wagers.findByIdempotencyKey(command.idempotencyKey);
    if (known) return replayOrConflict(known, command);

    const wallet = await repos.wallets.lockById(command.walletId);
    if (!wallet) {
      throw new NotFoundError(ErrorCodes.WalletNotFound, `Wallet ${command.walletId} not found`);
    }

    const committedMeanwhile = await repos.wagers.findByIdempotencyKey(command.idempotencyKey);
    if (committedMeanwhile) return replayOrConflict(committedMeanwhile, command);

    const sameExternalId = await repos.wagers.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (sameExternalId) {
      throw new ConflictError(
        ErrorCodes.IdempotencyConflict,
        'externalTransactionId was already used with another Idempotency-Key',
      );
    }

    const transaction = this.buildTransaction(command);
    const reference =
      command.referenceExternalTransactionId !== undefined
        ? await repos.wagers.findByProviderAndExternalId(
            command.providerId,
            command.referenceExternalTransactionId,
          )
        : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && transaction.isReversal()
        ? await repos.wagers.hasProcessedReversal(reference.id)
        : false;

    const outcome = applyWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      entryId: this.ids.next(),
      at: this.clock.now(),
      maxReferenceAttempts: this.settings.maxReferenceAttempts,
      scheduleReferenceRetry: (attempt, now) =>
        nextAttemptAt(now, attempt, this.settings.referenceBackoff),
    });

    repos.wagers.add(transaction);
    if (outcome.type === 'processed' && outcome.entry) {
      repos.ledger.append(outcome.entry);
      await repos.wallets.save(wallet);
    }

    const newEventContext = eventContextFactory(this.ids, this.clock, ctx);
    for (const event of eventsFor(outcome, transaction, newEventContext, wallet)) {
      repos.outbox.add(OutboxMessage.enqueue(event));
    }

    return toWagerResult(transaction, false);
  }

  private buildTransaction(command: NormalizedWagerCommand): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      at: this.clock.now(),
    });
  }
}

function replayOrConflict(known: WagerTransaction, command: NormalizedWagerCommand): WagerResult {
  if (!known.matchesPayload(command.payloadHash)) {
    throw new ConflictError(
      ErrorCodes.IdempotencyConflict,
      'Idempotency-Key was already used with a different payload',
    );
  }
  return toWagerResult(known, true);
}

function eventsFor(
  outcome: WagerOutcome,
  transaction: WagerTransaction,
  newContext: () => EventContext,
  wallet: Parameters<typeof WalletBalanceChanged.from>[0],
): IntegrationEvent<unknown>[] {
  switch (outcome.type) {
    case 'processed':
      return [
        WagerTransactionProcessed.from(transaction, newContext()),
        ...(outcome.entry ? [WalletBalanceChanged.from(wallet, outcome.entry, newContext())] : []),
      ];
    case 'rejected':
      return [WagerTransactionRejected.from(transaction, newContext())];
    case 'pending_reference':
      return [WagerTransactionPendingReference.from(transaction, newContext())];
  }
}
