import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
} from '../../modules/messaging/infra/persistence/messaging.schema';
import { WagerTransactionSchema } from '../../modules/wagering/infra/persistence/wager-transaction.schema';
import {
  LedgerEntrySchema,
  WalletSchema,
} from '../../modules/wallet/infra/persistence/wallet.schema';
import { Migration20261111000001InitialSchema } from './migrations/Migration20261111000001_initial_schema';

export const ENTITY_SCHEMAS = [
  WalletSchema,
  LedgerEntrySchema,
  WagerTransactionSchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];

/** Explicit list (no file globbing): works the same from source, tests and the Docker image. */
export const MIGRATIONS = [
  { name: 'Migration20261111000001_initial_schema', class: Migration20261111000001InitialSchema },
];

export interface OrmConfigOptions {
  clientUrl: string;
  poolMax?: number;
  debug?: boolean;
}

export function createOrmConfig(options: OrmConfigOptions): Options {
  return defineConfig({
    clientUrl: options.clientUrl,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    // Schema is owned by hand-written migrations (constraints/triggers), never by the ORM.
    schemaGenerator: { disableForeignKeys: false },
    forceUtcTimezone: true,
    pool: { min: 0, max: options.poolMax ?? 10 },
    debug: options.debug ?? false,
    allowGlobalContext: false,
  });
}
