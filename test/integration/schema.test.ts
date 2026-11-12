/**
 * Schema-level guarantees, exercised with raw SQL against a real PostgreSQL.
 * The point is to prove that the DATABASE refuses invalid states, even if the
 * application code had a bug.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, inTx, query, resetSchema, sqlError, uuid } from '../support/db';

let orm: MikroORM;
const NOW = '2026-07-29T15:00:00Z';

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
});

afterAll(async () => {
  await orm.close(true);
});

// ------------------------------------------------------------------ helpers

const insertWalletSql = `
  INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $6)`;

const insertTxSql = `
  INSERT INTO wager_transactions
    (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
     round_id, game_id, kind, amount, currency, reference_external_transaction_id,
     reference_transaction_id, status, failure_code, result_balance, result_balance_currency,
     processed_at, created_at, updated_at)
  VALUES ($1, $16, $2, $3, 'hash', $4, $5, 'round-1', 'game-1', $6, $7, 'BRL', $8,
          $9, $10, $11, $12, $13, $14, $15, $15)`;

const insertEntrySql = `
  INSERT INTO wallet_ledger_entries
    (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after,
     wallet_version, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

interface TxOptions {
  kind?: string;
  amount?: string;
  status?: string;
  failureCode?: string | null;
  refExternal?: string | null;
  refId?: string | null;
  externalId?: string;
  key?: string;
  provider?: string;
}

function txStatement(
  id: string,
  walletId: string,
  playerId: string,
  o: TxOptions = {},
): [string, unknown[]] {
  const status = o.status ?? 'PROCESSED';
  const externalId = o.externalId ?? `ext-${id}`;
  return [
    insertTxSql,
    [
      id,
      externalId,
      o.key ?? `provider-a:${externalId}`,
      walletId,
      playerId,
      o.kind ?? 'BET',
      o.amount ?? '10.00',
      o.refExternal ?? null,
      o.refId ?? null,
      status,
      o.failureCode ?? null,
      status === 'PENDING' ? null : '0.00',
      status === 'PENDING' ? null : 'BRL',
      status === 'PROCESSED' ? NOW : null,
      NOW,
      o.provider ?? (o.kind === 'OPENING' ? 'internal' : 'provider-a'),
    ],
  ];
}

interface OpenedWallet {
  walletId: string;
  playerId: string;
  openingTxId: string;
}

/** Valid wallet opened with `balance` through an OPENING transaction + CREDIT entry. */
async function openWallet(balance = '100.00'): Promise<OpenedWallet> {
  const walletId = uuid();
  const playerId = uuid();
  const openingTxId = uuid();
  await inTx(orm, [
    [insertWalletSql, [walletId, playerId, 'BRL', balance, 1, NOW]],
    txStatement(openingTxId, walletId, playerId, { kind: 'OPENING', amount: balance }),
    [
      insertEntrySql,
      [uuid(), walletId, openingTxId, 'CREDIT', balance, 'BRL', '0.00', balance, 1, NOW],
    ],
  ]);
  return { walletId, playerId, openingTxId };
}

/** Applies a valid BET debit: tx + entry + wallet update in one SQL transaction. */
async function debit(
  w: OpenedWallet,
  amount: string,
  before: string,
  after: string,
  version: number,
) {
  const txId = uuid();
  await inTx(orm, [
    txStatement(txId, w.walletId, w.playerId, { amount }),
    [
      insertEntrySql,
      [uuid(), w.walletId, txId, 'DEBIT', amount, 'BRL', before, after, version, NOW],
    ],
    ['UPDATE wallets SET balance = $1, version = $2 WHERE id = $3', [after, version, w.walletId]],
  ]);
  return txId;
}

// -------------------------------------------------------------------- tests

describe('migrations', () => {
  it('are reversible: down removes every object, up recreates them', async () => {
    const tables = async () =>
      (
        await query<{ table_name: string }>(
          orm,
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'
            ORDER BY table_name`,
        )
      ).map((r) => r.table_name);

    expect(await tables()).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
    await orm.migrator.down({ to: 0 });
    expect(await tables()).toEqual([]);
    const functions = await query(
      orm,
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'`,
    );
    expect(functions).toEqual([]);
    await orm.migrator.up();
    expect((await tables()).length).toBe(5);
  });
});

describe('wallets', () => {
  it('allows a valid wallet opened through the ledger', async () => {
    const w = await openWallet('100.00');
    const [row] = await query<{ balance: string; version: number }>(
      orm,
      'SELECT balance, version FROM wallets WHERE id = $1',
      [w.walletId],
    );
    expect(row).toEqual({ balance: '100.00', version: 1 });
  });

  it('allows a zero-balance wallet without ledger entries', async () => {
    await inTx(orm, [[insertWalletSql, [uuid(), uuid(), 'BRL', '0.00', 1, NOW]]]);
  });

  it('one wallet per player + currency', async () => {
    const playerId = uuid();
    await inTx(orm, [[insertWalletSql, [uuid(), playerId, 'BRL', '0.00', 1, NOW]]]);
    const err = await sqlError(() =>
      inTx(orm, [[insertWalletSql, [uuid(), playerId, 'BRL', '0.00', 1, NOW]]]),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('wallets_player_currency_uq');
    // another currency for the same player is fine
    await inTx(orm, [[insertWalletSql, [uuid(), playerId, 'USD', '0.00', 1, NOW]]]);
  });

  it('balance can never be negative', async () => {
    const err = await sqlError(() =>
      inTx(orm, [[insertWalletSql, [uuid(), uuid(), 'BRL', '-0.01', 1, NOW]]]),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('wallets_balance_non_negative_chk');
  });

  it('rejects invalid currency codes', async () => {
    const err = await sqlError(() =>
      inTx(orm, [[insertWalletSql, [uuid(), uuid(), 'brl', '0.00', 1, NOW]]]),
    );
    expect(err.constraint).toBe('wallets_currency_format_chk');
  });

  it('opening with a positive balance but no ledger entry fails at COMMIT', async () => {
    const err = await sqlError(() =>
      inTx(orm, [[insertWalletSql, [uuid(), uuid(), 'BRL', '50.00', 1, NOW]]]),
    );
    expect(err.code).toBe('WG003');
  });

  it('changing the balance without a matching ledger entry fails at COMMIT', async () => {
    const w = await openWallet('100.00');
    const err = await sqlError(() =>
      inTx(orm, [['UPDATE wallets SET balance = 80, version = 2 WHERE id = $1', [w.walletId]]]),
    );
    expect(err.code).toBe('WG003');
  });

  it('version must move by exactly +1 when the balance changes, and only then', async () => {
    const w = await openWallet('100.00');
    const skip = await sqlError(() =>
      inTx(orm, [['UPDATE wallets SET balance = 80, version = 3 WHERE id = $1', [w.walletId]]]),
    );
    expect(skip.code).toBe('WG003');
    const silent = await sqlError(() =>
      inTx(orm, [['UPDATE wallets SET version = 2 WHERE id = $1', [w.walletId]]]),
    );
    expect(silent.code).toBe('WG003');
  });

  it('identity columns are immutable and wallets are never deleted', async () => {
    const w = await openWallet('10.00');
    const err = await sqlError(() =>
      inTx(orm, [["UPDATE wallets SET currency = 'USD' WHERE id = $1", [w.walletId]]]),
    );
    expect(err.code).toBe('WG003');
    const del = await sqlError(() =>
      inTx(orm, [['DELETE FROM wallets WHERE id = $1', [w.walletId]]]),
    );
    expect(del.code).toBe('WG003');
  });

  it('a full debit (tx + entry + wallet) commits and stays consistent', async () => {
    const w = await openWallet('100.00');
    await debit(w, '80.00', '100.00', '20.00', 2);
    const [check] = await query<{ balance: string; ledger: string }>(
      orm,
      `SELECT w.balance,
              (SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
                 FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20,2)::text AS ledger
         FROM wallets w WHERE w.id = $1`,
      [w.walletId],
    );
    expect(check).toEqual({ balance: '20.00', ledger: '20.00' });
  });
});

describe('wallet_ledger_entries', () => {
  it('rejects broken arithmetic', async () => {
    const w = await openWallet('100.00');
    const txId = uuid();
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(txId, w.walletId, w.playerId),
        [
          insertEntrySql,
          [uuid(), w.walletId, txId, 'DEBIT', '10.00', 'BRL', '100.00', '95.00', 2, NOW],
        ],
      ]),
    );
    expect(err.constraint).toBe('ledger_arithmetic_chk');
  });

  it('rejects a debit that would go negative', async () => {
    const w = await openWallet('5.00');
    const txId = uuid();
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(txId, w.walletId, w.playerId),
        [
          insertEntrySql,
          [uuid(), w.walletId, txId, 'DEBIT', '10.00', 'BRL', '5.00', '-5.00', 2, NOW],
        ],
      ]),
    );
    expect(err.code).toBe('23514');
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are blocked', async () => {
    await openWallet('100.00');
    const update = await sqlError(() =>
      inTx(orm, [['UPDATE wallet_ledger_entries SET amount = amount + 1', []]]),
    );
    expect(update.code).toBe('WG001');
    const del = await sqlError(() => inTx(orm, [['DELETE FROM wallet_ledger_entries', []]]));
    expect(del.code).toBe('WG001');
    const truncate = await sqlError(() =>
      inTx(orm, [['TRUNCATE wallet_ledger_entries CASCADE', []]]),
    );
    expect(truncate.code).toBe('WG001');
  });

  it('at most one entry per transaction', async () => {
    const w = await openWallet('100.00');
    const err = await sqlError(() =>
      inTx(orm, [
        [
          insertEntrySql,
          [uuid(), w.walletId, w.openingTxId, 'CREDIT', '1.00', 'BRL', '100.00', '101.00', 2, NOW],
        ],
      ]),
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('ledger_transaction_uq');
  });

  it('two writers can never produce the same wallet version (lost update guard)', async () => {
    const w = await openWallet('100.00');
    await debit(w, '80.00', '100.00', '20.00', 2);
    const err = await sqlError(() => debit(w, '80.00', '100.00', '20.00', 2));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('ledger_wallet_version_uq');
  });

  it('each entry must chain to the previous balance_after', async () => {
    const w = await openWallet('100.00');
    const txId = uuid();
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(txId, w.walletId, w.playerId),
        [
          insertEntrySql,
          [uuid(), w.walletId, txId, 'DEBIT', '10.00', 'BRL', '90.00', '80.00', 2, NOW],
        ],
      ]),
    );
    expect(err.code).toBe('WG003');
  });

  it('entry currency must equal the wallet currency', async () => {
    const w = await openWallet('100.00');
    const txId = uuid();
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(txId, w.walletId, w.playerId),
        [
          insertEntrySql,
          [uuid(), w.walletId, txId, 'DEBIT', '10.00', 'USD', '100.00', '90.00', 2, NOW],
        ],
        ['UPDATE wallets SET balance = 90, version = 2 WHERE id = $1', [w.walletId]],
      ]),
    );
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('ledger_wallet_currency_fk');
  });

  it('the transaction must belong to the same wallet', async () => {
    const a = await openWallet('100.00');
    const b = await openWallet('100.00');
    const txOfB = uuid();
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(txOfB, b.walletId, b.playerId),
        [
          insertEntrySql,
          [uuid(), a.walletId, txOfB, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', 2, NOW],
        ],
        ['UPDATE wallets SET balance = 90, version = 2 WHERE id = $1', [a.walletId]],
      ]),
    );
    expect(err.constraint).toBe('ledger_transaction_wallet_fk');
  });
});

describe('wager_transactions', () => {
  it('idempotency key is unique', async () => {
    const w = await openWallet('100.00');
    const st = (id: string, ext: string) =>
      txStatement(id, w.walletId, w.playerId, {
        status: 'PENDING',
        externalId: ext,
        key: 'same-key',
      });
    await inTx(orm, [st(uuid(), 'e1')]);
    const err = await sqlError(() => inTx(orm, [st(uuid(), 'e2')]));
    expect(err.constraint).toBe('wager_tx_idempotency_key_uq');
  });

  it('(provider, external id) is unique', async () => {
    const w = await openWallet('100.00');
    const st = (key: string) =>
      txStatement(uuid(), w.walletId, w.playerId, { status: 'PENDING', externalId: 'dup', key });
    await inTx(orm, [st('k1')]);
    const err = await sqlError(() => inTx(orm, [st('k2')]));
    expect(err.constraint).toBe('wager_tx_provider_external_uq');
  });

  it('REFUND/ROLLBACK require a reference; BET cannot have one', async () => {
    const w = await openWallet('100.00');
    const refund = await sqlError(() =>
      inTx(orm, [
        txStatement(uuid(), w.walletId, w.playerId, { kind: 'REFUND', status: 'PENDING' }),
      ]),
    );
    expect(refund.constraint).toBe('wager_tx_reversal_requires_reference_chk');
    const bet = await sqlError(() =>
      inTx(orm, [
        txStatement(uuid(), w.walletId, w.playerId, { status: 'PENDING', refExternal: 'x' }),
      ]),
    );
    expect(bet.constraint).toBe('wager_tx_no_reference_for_kind_chk');
  });

  it('rejected transactions must carry a failure code', async () => {
    const w = await openWallet('100.00');
    const err = await sqlError(() =>
      inTx(orm, [txStatement(uuid(), w.walletId, w.playerId, { status: 'REJECTED' })]),
    );
    expect(err.constraint).toBe('wager_tx_failure_code_chk');
  });

  it('amount must be positive (LOSS may be zero)', async () => {
    const w = await openWallet('100.00');
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(uuid(), w.walletId, w.playerId, { amount: '0.00', status: 'PENDING' }),
      ]),
    );
    expect(err.constraint).toBe('wager_tx_amount_chk');
    await inTx(orm, [
      txStatement(uuid(), w.walletId, w.playerId, {
        kind: 'LOSS',
        amount: '0.00',
        status: 'PENDING',
      }),
    ]);
  });

  it('terminal transactions are immutable and nothing is ever deleted', async () => {
    const w = await openWallet('100.00');
    const err = await sqlError(() =>
      inTx(orm, [
        [
          "UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X', processed_at = NULL WHERE id = $1",
          [w.openingTxId],
        ],
      ]),
    );
    expect(err.code).toBe('WG002');
    const del = await sqlError(() =>
      inTx(orm, [['DELETE FROM wager_transactions WHERE id = $1', [w.openingTxId]]]),
    );
    expect(del.code).toBe('WG002');
  });

  it('business columns cannot change even while PENDING', async () => {
    const w = await openWallet('100.00');
    const id = uuid();
    await inTx(orm, [txStatement(id, w.walletId, w.playerId, { status: 'PENDING' })]);
    const err = await sqlError(() =>
      inTx(orm, [['UPDATE wager_transactions SET amount = 999 WHERE id = $1', [id]]]),
    );
    expect(err.code).toBe('WG002');
  });

  it('a reference can be reversed at most once (REFUND or ROLLBACK)', async () => {
    const w = await openWallet('100.00');
    const betId = await debit(w, '10.00', '100.00', '90.00', 2);
    const reversal = (
      kind: string,
      ext: string,
      before: string,
      after: string,
      version: number,
    ) => {
      const id = uuid();
      return inTx(orm, [
        txStatement(id, w.walletId, w.playerId, {
          kind,
          externalId: ext,
          refExternal: `ext-${betId}`,
          refId: betId,
        }),
        [
          insertEntrySql,
          [uuid(), w.walletId, id, 'CREDIT', '10.00', 'BRL', before, after, version, NOW],
        ],
        [
          'UPDATE wallets SET balance = $1, version = $2 WHERE id = $3',
          [after, version, w.walletId],
        ],
      ]);
    };
    await reversal('REFUND', 'refund-1', '90.00', '100.00', 3);
    const err = await sqlError(() => reversal('ROLLBACK', 'rollback-1', '100.00', '110.00', 4));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('wager_tx_single_reversal_uq');
  });
});

describe('ledger <-> transaction consistency (review findings)', () => {
  it('a ledger entry without the matching wallet update fails at COMMIT ("e vice-versa")', async () => {
    const w = await openWallet('100.00');
    const txId = uuid();
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(txId, w.walletId, w.playerId, { amount: '10.00' }),
        [
          insertEntrySql,
          [uuid(), w.walletId, txId, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', 2, NOW],
        ],
        // wallet NOT updated: balance stays 100.00 while the ledger says 90.00
      ]),
    );
    expect(err.code).toBe('WG003');
  });

  it('a stray OPENING-like entry on a zero-balance wallet fails at COMMIT', async () => {
    const walletId = uuid();
    const playerId = uuid();
    const txId = uuid();
    const err = await sqlError(() =>
      inTx(orm, [
        [insertWalletSql, [walletId, playerId, 'BRL', '0.00', 1, NOW]],
        txStatement(txId, walletId, playerId, { kind: 'WIN', amount: '50.00' }),
        [
          insertEntrySql,
          [uuid(), walletId, txId, 'CREDIT', '50.00', 'BRL', '0.00', '50.00', 1, NOW],
        ],
      ]),
    );
    expect(err.code).toBe('WG003');
  });

  it.each([
    ['REJECTED transaction', { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' }, 'DEBIT'],
    ['PENDING transaction', { status: 'PENDING' }, 'DEBIT'],
    ['LOSS', { kind: 'LOSS' }, 'DEBIT'],
    ['BET recorded as CREDIT', {}, 'CREDIT'],
    ['WIN recorded as DEBIT', { kind: 'WIN' }, 'DEBIT'],
    ['amount different from the transaction', { amount: '11.00' }, 'DEBIT'],
  ])('rejects a ledger entry for a %s', async (_label, txOptions, direction) => {
    const w = await openWallet('100.00');
    const txId = uuid();
    const after = direction === 'DEBIT' ? '90.00' : '110.00';
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(txId, w.walletId, w.playerId, { amount: '10.00', ...txOptions }),
        [
          insertEntrySql,
          [uuid(), w.walletId, txId, direction, '10.00', 'BRL', '100.00', after, 2, NOW],
        ],
        ['UPDATE wallets SET balance = $1, version = 2 WHERE id = $2', [after, w.walletId]],
      ]),
    );
    expect(err.code).toBe('WG003');
  });

  it('OPENING is internal: an external provider cannot use it', async () => {
    const w = await openWallet('100.00');
    const err = await sqlError(() =>
      inTx(orm, [
        txStatement(uuid(), w.walletId, w.playerId, {
          kind: 'OPENING',
          status: 'PENDING',
          provider: 'provider-a',
        }),
      ]),
    );
    expect(err.constraint).toBe('wager_tx_opening_internal_chk');
  });
});

describe('inbox_messages', () => {
  it('(consumer, messageId) is unique', async () => {
    const insert: [string, unknown[]] = [
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES ('wager-consumer', 'msg-1', 'h', now())`,
      [],
    ];
    await inTx(orm, [insert]);
    const err = await sqlError(() => inTx(orm, [insert]));
    expect(err.constraint).toBe('inbox_messages_pk');
  });
});
