import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { RequestContext } from '../../../http/request-context';
import { parseOrThrow } from '../../../http/validation';
import type { ExecutionContext } from '../../../shared/application/ports';
import type { FailureCode } from '../../../shared/domain/failure-code';
import type { MoneyProps } from '../../../shared/domain/money';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from '../../auth/auth';
import { moneySchema } from '../../wallet/http/wallet.controller';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case';
import { WagerReadUseCases } from '../application/wager-queries';
import type { WagerResult } from '../application/wager-result';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction-kind';

const text = (max: number) => z.string().trim().min(1).max(max);

/** Contract shared by HTTP and the SQS consumer. */
export const wagerPayloadSchema = z.strictObject({
  providerId: text(100),
  externalTransactionId: text(200),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text(200),
  gameId: text(200),
  kind: z.string().min(1).max(20),
  money: moneySchema,
  referenceExternalTransactionId: text(200).optional(),
});

const idempotencyKeySchema = z
  .string({ error: 'Idempotency-Key header is required' })
  .trim()
  .min(1, 'Idempotency-Key header is required')
  .max(255);

/**
 * Status mapping (consistent across endpoints):
 *   201 processed now | 200 idempotent replay of a processed transaction
 *   202 accepted, waiting for the referenced transaction (PENDING_REFERENCE)
 *   422 business rejection (failureCode) - replays keep 422
 */
export function httpStatusFor(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

export interface WagerResultView {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  nextAttemptAt?: string;
}

export const wagerResultView = (r: WagerResult): WagerResultView => ({
  transactionId: r.transactionId,
  status: r.status,
  balance: r.balance ?? null,
  idempotentReplay: r.idempotentReplay,
  ...(r.failureCode !== undefined ? { failureCode: r.failureCode } : {}),
  ...(r.nextAttemptAt !== undefined ? { nextAttemptAt: r.nextAttemptAt } : {}),
});

const transactionView = (tx: WagerTransaction) => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  idempotencyKey: tx.idempotencyKey,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  balance: tx.resultBalance?.toJSON() ?? null,
  referenceAttempts: tx.referenceAttempts,
  nextAttemptAt: tx.nextReferenceAttemptAt?.toISOString() ?? null,
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString() ?? null,
});

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly reads: WagerReadUseCases,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Body() body: unknown,
    @RequestContext() ctx: ExecutionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResultView> {
    const key = parseOrThrow(idempotencyKeySchema, idempotencyKey, 'Idempotency-Key');
    const payload = parseOrThrow(wagerPayloadSchema, body, 'body');
    this.identity.assertMayActAs(payload.providerId);

    const result = await this.processWager.execute({ ...payload, idempotencyKey: key }, ctx);
    res.status(httpStatusFor(result));
    return wagerResultView(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    const id = parseOrThrow(z.uuid(), transactionId, 'transactionId');
    return transactionView(await this.reads.getById(id));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return transactionView(
      await this.reads.getByProviderAndExternalId(
        parseOrThrow(text(100), providerId, 'providerId'),
        parseOrThrow(text(200), externalTransactionId, 'externalTransactionId'),
      ),
    );
  }
}
