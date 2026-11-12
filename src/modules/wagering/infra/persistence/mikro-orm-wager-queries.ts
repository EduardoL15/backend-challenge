import type { MikroORM } from '@mikro-orm/postgresql';
import type { WagerQueries } from '../../application/wager-queries';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionRecord } from './wager-transaction.schema';

export class MikroOrmWagerQueries implements WagerQueries {
  constructor(private readonly orm: MikroORM) {}

  async findById(transactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, { id: transactionId });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.orm.em
      .fork()
      .findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}
