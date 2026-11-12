import { randomUUID } from 'node:crypto';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering_test';

if (!TEST_DATABASE_URL.includes('_test')) {
  throw new Error(
    `Refusing to run destructive tests against a non-test database: ${TEST_DATABASE_URL}`,
  );
}

export async function createTestOrm(poolMax = 5): Promise<MikroORM> {
  return MikroORM.init(createOrmConfig({ clientUrl: TEST_DATABASE_URL, poolMax }));
}

/** Drops everything through the real down-migrations, then applies them again. */
export async function resetSchema(orm: MikroORM): Promise<void> {
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
}

export const uuid = (): string => randomUUID();

export interface SqlErrorInfo {
  code: string | undefined;
  constraint: string | undefined;
  message: string;
}

/** Runs fn and returns the database error it raised (fails the test if it did not throw). */
export async function sqlError(fn: () => Promise<unknown>): Promise<SqlErrorInfo> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: string; constraint?: string; message?: string };
    return { code: e.code, constraint: e.constraint, message: e.message ?? String(error) };
  }
  throw new Error('Expected the database to reject the statement, but it succeeded');
}

/**
 * MikroORM's em.execute uses positional `?` placeholders. Tests are written with PostgreSQL
 * `$n` placeholders (which may repeat), so translate them and expand the params accordingly.
 */
function toPositional(sql: string, params: unknown[]): [string, unknown[]] {
  const expanded: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    expanded.push(params[Number(n) - 1]);
    return '?';
  });
  return [text, expanded];
}

async function run<T>(em: EntityManager, sql: string, params: unknown[]): Promise<T[]> {
  const [text, values] = toPositional(sql, params);
  return em.execute<T[]>(text, values);
}

/** Executes statements in one SQL transaction (deferred constraints are checked at COMMIT). */
export async function inTx(orm: MikroORM, statements: [string, unknown[]?][]): Promise<void> {
  await orm.em.fork().transactional(async (em: EntityManager) => {
    for (const [sql, params] of statements) {
      await run(em, sql, params ?? []);
    }
  });
}

export async function query<T = Record<string, unknown>>(
  orm: MikroORM,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return run<T>(orm.em.fork(), sql, params);
}
