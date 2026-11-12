import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../../../shared/domain/money';
import type {
  LedgerPage,
  ReconciliationSnapshot,
  WalletQueries,
} from '../../application/wallet-queries';
import type { Wallet } from '../../domain/wallet';
import { LedgerEntryMapper, WalletMapper } from './wallet.mapper';
import { LedgerEntryRecord, WalletRecord } from './wallet.schema';

export class MikroOrmWalletQueries implements WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async ledgerPage(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPage> {
    // seq is a bigint; compare on the database side to avoid any precision loss.
    const records = await this.orm.em
      .fork()
      .find(
        LedgerEntryRecord,
        afterSeq !== undefined ? { walletId, seq: { $gt: afterSeq } } : { walletId },
        { orderBy: { seq: 'asc' }, limit: limit + 1 },
      );
    const hasMore = records.length > limit;
    return {
      hasMore,
      items: records.slice(0, limit).map((record) => ({
        entry: LedgerEntryMapper.toDomain(record),
        seq: record.seq ?? '0',
      })),
    };
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // ONE statement => one MVCC snapshot: balance and ledger sum are read at the same instant.
    const rows = await this.orm.em
      .fork()
      .execute<{ balance: string; currency: string; calculated: string; entries: number }[]>(
        `SELECT w.balance::text AS balance,
              w.currency,
              COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
                ::numeric(20,2)::text AS calculated,
              COUNT(l.id)::int AS entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
        [walletId],
      );
    const row = rows[0];
    if (!row) return undefined;
    return {
      storedBalance: Money.fromSignedDecimal(row.balance, row.currency),
      calculatedBalance: Money.fromSignedDecimal(row.calculated, row.currency),
      checkedEntries: row.entries,
    };
  }
}
