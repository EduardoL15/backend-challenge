import { Inject, Injectable } from '@nestjs/common';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import {
  ConflictError,
  ErrorCodes,
  InboxPayloadMismatchError,
  NotFoundError,
  UniqueViolationError,
} from '../../../shared/application/errors';
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
import { type AppMetrics, METRICS, type WagerSource } from '../../../shared/application/metrics';
import { addContext } from '../../../observability/context';
import { inSpan, setSpanAttributes } from '../../../observability/tracing';
import { WagerTransaction } from '../domain/wager-transaction';
import { WagerApplier } from './wager-applier';
import {
  type NormalizedWagerCommand,
  type WagerCommand,
  normalizeWagerCommand,
} from './wager-command';
import { type WagerResult, toWagerResult } from './wager-result';

export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  /** Hash of the whole message: the same messageId with another body is a poison message. */
  payloadHash: string;
}

export type MessageExecution =
  { kind: 'processed'; result: WagerResult } | { kind: 'duplicate_message' };

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
    @Inject(METRICS) private readonly metrics: AppMetrics,
    private readonly applier: WagerApplier,
  ) {}

  /** HTTP entry point. */
  async execute(command: WagerCommand, ctx: ExecutionContext): Promise<WagerResult> {
    const execution = await this.run(command, ctx, undefined);
    if (execution.kind !== 'processed') {
      throw new Error('Unreachable: duplicate message without an inbox receipt');
    }
    return execution.result;
  }

  /**
   * Queue entry point: SAME flow, plus the inbox row (consumer, messageId) written in the
   * SAME SQL transaction as the financial effects. If the row already exists, the message was
   * fully processed and committed before (redelivery): nothing is done again.
   */
  async executeFromMessage(
    command: WagerCommand,
    ctx: ExecutionContext,
    receipt: InboxReceipt,
  ): Promise<MessageExecution> {
    return this.run(command, ctx, receipt);
  }

  private run(
    command: WagerCommand,
    ctx: ExecutionContext,
    receipt: InboxReceipt | undefined,
  ): Promise<MessageExecution> {
    const source: WagerSource = receipt ? 'sqs' : 'http';
    addContext({ walletId: command.walletId, providerId: command.providerId });
    return inSpan(
      'wager.process',
      { 'wagering.kind': command.kind, 'wagering.source': source },
      async () => {
        const started = performance.now();
        const execution = await this.runWithRaceRetry(command, ctx, receipt);
        this.report(execution, command.kind, source, performance.now() - started);
        return execution;
      },
    );
  }

  private async runWithRaceRetry(
    command: WagerCommand,
    ctx: ExecutionContext,
    receipt: InboxReceipt | undefined,
  ): Promise<MessageExecution> {
    const normalized = normalizeWagerCommand(command);
    // Validate the contract before any I/O (OPENING, missing reference, amount rules...).
    this.buildTransaction(normalized);

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.uow.run(async (repos): Promise<MessageExecution> => {
          if (receipt && !(await this.receive(repos, receipt))) {
            return { kind: 'duplicate_message' };
          }
          return { kind: 'processed', result: await this.process(repos, normalized, ctx) };
        });
      } catch (error) {
        const isRace =
          error instanceof UniqueViolationError &&
          error.constraint !== undefined &&
          RACE_CONSTRAINTS.has(error.constraint);
        if (isRace && attempt < MAX_RACE_RETRIES) {
          this.metrics.lockConflict('unique_race');
          continue;
        }
        throw error;
      }
    }
  }

  private report(
    execution: MessageExecution,
    kind: string,
    source: WagerSource,
    durationMs: number,
  ): void {
    if (execution.kind === 'duplicate_message') {
      this.metrics.duplicateDetected('inbox', source);
      return;
    }
    const { result } = execution;
    addContext({ transactionId: result.transactionId });
    setSpanAttributes({
      'wagering.status': result.status,
      'wagering.replay': result.idempotentReplay,
    });
    if (result.idempotentReplay) this.metrics.duplicateDetected('idempotency_key', source);
    this.metrics.wagerHandled({
      source,
      kind,
      status: result.status,
      replay: result.idempotentReplay,
      durationMs,
    });
  }

  /** Returns false when (consumer, messageId) was already processed and committed. */
  private async receive(repos: TransactionalRepositories, receipt: InboxReceipt): Promise<boolean> {
    const now = this.clock.now();
    const message = InboxMessage.receive({ ...receipt, at: now });
    message.markProcessed(now); // committed together with the effects, or rolled back with them
    if (await repos.inbox.tryReceive(message)) return true;

    const existing = await repos.inbox.find(receipt.consumerName, receipt.messageId);
    if (existing && existing.payloadHash !== receipt.payloadHash) {
      throw new InboxPayloadMismatchError(receipt.messageId);
    }
    return false;
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
    await this.applier.apply(repos, transaction, wallet, ctx, 'insert');
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
