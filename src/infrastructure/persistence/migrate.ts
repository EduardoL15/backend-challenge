/**
 * Migration CLI.
 *   bun run migration:up              apply all pending migrations
 *   bun run migration:down            revert the last migration
 *   bun run migration:down -- --all   revert everything
 *   bun run migration:status          list executed / pending
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../config/env';
import { createOrmConfig } from './mikro-orm.config';

async function main(): Promise<void> {
  const [command = 'up', ...flags] = process.argv.slice(2);
  const env = loadEnv();
  const orm = await MikroORM.init(createOrmConfig({ clientUrl: env.DATABASE_URL, poolMax: 1 }));
  try {
    const migrator = orm.migrator;
    switch (command) {
      case 'up': {
        const done = await migrator.up();
        console.log(done.length ? `Applied: ${done.map((m) => m.name).join(', ')}` : 'Up to date');
        break;
      }
      case 'down': {
        const done = await migrator.down(flags.includes('--all') ? { to: 0 } : undefined);
        console.log(done.length ? `Reverted: ${done.map((m) => m.name).join(', ')}` : 'Nothing');
        break;
      }
      case 'status': {
        const executed = await migrator.getExecuted();
        const pending = await migrator.getPending();
        console.log(
          'Executed:',
          executed.map((m) => m.name),
        );
        console.log(
          'Pending:',
          pending.map((m) => m.name),
        );
        break;
      }
      default:
        throw new Error(`Unknown command "${command}" (use up | down | status)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
