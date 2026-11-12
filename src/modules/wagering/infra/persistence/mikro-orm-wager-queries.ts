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

  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    // Served by the partial index wager_tx_pending_reference_due_idx.
    const records = await this.orm.em
      .fork()
      .find(
        WagerTransactionRecord,
        { status: 'PENDING_REFERENCE', nextReferenceAttemptAt: { $lte: now } },
        { orderBy: { nextReferenceAttemptAt: 'asc' }, limit, fields: ['id'] },
      );
    return records.map((r) => r.id);
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
