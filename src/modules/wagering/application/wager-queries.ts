import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes, NotFoundError } from '../../../shared/application/errors';
import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerQueries {
  findById(transactionId: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
}
export const WAGER_QUERIES = Symbol('WagerQueries');

@Injectable()
export class WagerReadUseCases {
  constructor(@Inject(WAGER_QUERIES) private readonly queries: WagerQueries) {}

  async getById(transactionId: string): Promise<WagerTransaction> {
    return orNotFound(await this.queries.findById(transactionId));
  }

  async getByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    return orNotFound(
      await this.queries.findByProviderAndExternalId(providerId, externalTransactionId),
    );
  }
}

function orNotFound(tx: WagerTransaction | undefined): WagerTransaction {
  if (!tx) throw new NotFoundError(ErrorCodes.TransactionNotFound, 'Transaction not found');
  return tx;
}
