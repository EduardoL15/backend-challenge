import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every financial guarantee is enforced HERE, not only in application code:
 *
 *  - uniqueness: one wallet per (player, currency); idempotency key; (provider, external id);
 *    at most one ledger entry per transaction; one ledger entry per (wallet, version);
 *    a reference can be reversed at most once (partial unique index).
 *  - non-negativity: CHECK balance >= 0 on wallets and ledger.
 *  - immutability: ledger is append-only (UPDATE/DELETE/TRUNCATE raise); terminal wager
 *    transactions cannot change; business columns of a transaction cannot change.
 *  - consistency: ledger arithmetic CHECK; each entry chains to the previous one; a deferred
 *    constraint trigger guarantees wallet.balance/version always match its latest ledger entry.
 *
 * Custom SQLSTATEs raised by triggers (class "WG"):
 *   WG001 ledger is append-only         WG002 terminal / immutable wager transaction
 *   WG003 wallet <-> ledger inconsistency
 *
 * Foreign keys are DEFERRABLE INITIALLY DEFERRED so the ORM flush order inside a single
 * SQL transaction does not matter; they are still checked at COMMIT.
 */
export class Migration20261111000001InitialSchema extends Migration {
  override name = 'Migration20261111000001_initial_schema';

  override up(): void {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL CONSTRAINT wallets_currency_format_chk CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) NOT NULL CONSTRAINT wallets_balance_non_negative_chk CHECK (balance >= 0),
        version     integer       NOT NULL CONSTRAINT wallets_version_positive_chk CHECK (version >= 1),
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        -- target of the composite FK that pins ledger currency to wallet currency
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency)
      );
    `);

    // ------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL CONSTRAINT wager_tx_provider_not_empty_chk CHECK (provider_id <> ''),
        external_transaction_id           text          NOT NULL CONSTRAINT wager_tx_external_id_not_empty_chk CHECK (external_transaction_id <> ''),
        idempotency_key                   text          NOT NULL CONSTRAINT wager_tx_idempotency_key_not_empty_chk CHECK (idempotency_key <> ''),
        payload_hash                      text          NOT NULL,
        wallet_id                         uuid          NOT NULL,
        player_id                         uuid          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL CONSTRAINT wager_tx_kind_chk
                                            CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid,
        status                            text          NOT NULL CONSTRAINT wager_tx_status_chk
                                            CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text,
        -- wallet balance observed when the transaction was resolved (replays return it);
        -- in the WALLET currency, which differs from "currency" on CURRENCY_MISMATCH
        result_balance                    numeric(20,2),
        result_balance_currency           char(3),
        reference_attempts                integer       NOT NULL DEFAULT 0 CONSTRAINT wager_tx_reference_attempts_chk CHECK (reference_attempts >= 0),
        next_reference_attempt_at         timestamptz,
        processed_at                      timestamptz,
        created_at                        timestamptz   NOT NULL,
        updated_at                        timestamptz   NOT NULL,

        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        -- target of the composite FK that pins a ledger entry to the transaction's wallet
        CONSTRAINT wager_tx_id_wallet_uq UNIQUE (id, wallet_id),

        CONSTRAINT wager_tx_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id)
          DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT wager_tx_reference_fk FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id)
          DEFERRABLE INITIALLY DEFERRED,

        CONSTRAINT wager_tx_amount_chk CHECK (
          (kind = 'LOSS' AND amount >= 0) OR (kind <> 'LOSS' AND amount > 0)
        ),
        CONSTRAINT wager_tx_reversal_requires_reference_chk CHECK (
          kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        -- OPENING is internal: only the internal provider creates it, and it creates nothing else
        CONSTRAINT wager_tx_opening_internal_chk CHECK (
          (kind = 'OPENING') = (provider_id = 'internal')
        ),
        CONSTRAINT wager_tx_no_reference_for_kind_chk CHECK (
          kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL
        ),
        CONSTRAINT wager_tx_failure_code_chk CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT wager_tx_processed_at_chk CHECK (
          (status = 'PROCESSED') = (processed_at IS NOT NULL)
        ),
        CONSTRAINT wager_tx_resolved_reference_chk CHECK (
          reference_transaction_id IS NULL
          OR (status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL)
        ),
        CONSTRAINT wager_tx_result_balance_pair_chk CHECK (
          (result_balance IS NULL) = (result_balance_currency IS NULL)
        ),
        CONSTRAINT wager_tx_pending_reference_schedule_chk CHECK (
          status <> 'PENDING_REFERENCE' OR next_reference_attempt_at IS NOT NULL
        )
      );
    `);
    // A referenced transaction can be reversed (REFUND or ROLLBACK) at most once.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
    `);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id);`);

    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager transactions are never deleted (id=%)', OLD.id USING ERRCODE = 'WG002';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'WG002';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'business columns of wager transaction % are immutable', OLD.id USING ERRCODE = 'WG002';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_trg
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard();
    `);

    // --------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        seq             bigint        GENERATED ALWAYS AS IDENTITY,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL,
        direction       text          NOT NULL CONSTRAINT ledger_direction_chk CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2) NOT NULL CONSTRAINT ledger_amount_positive_chk CHECK (amount > 0),
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL CONSTRAINT ledger_balance_before_non_negative_chk CHECK (balance_before >= 0),
        balance_after   numeric(20,2) NOT NULL CONSTRAINT ledger_balance_after_non_negative_chk CHECK (balance_after >= 0),
        wallet_version  integer       NOT NULL CONSTRAINT ledger_wallet_version_positive_chk CHECK (wallet_version >= 1),
        created_at      timestamptz   NOT NULL,

        CONSTRAINT ledger_seq_uq UNIQUE (seq),
        -- at most one entry per financial transaction
        CONSTRAINT ledger_transaction_uq UNIQUE (transaction_id),
        -- one entry per wallet version: two writers can never both produce version N
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_arithmetic_chk CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        ),
        -- same currency as the wallet
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency) DEFERRABLE INITIALLY DEFERRED,
        -- the transaction belongs to the same wallet
        CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id) DEFERRABLE INITIALLY DEFERRED
      );
    `);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq);`);

    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP USING ERRCODE = 'WG001';
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_append_only_trg
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate_trg
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
    `);

    // Each entry must chain to the previous one of the same wallet.
    this.addSql(`
      CREATE FUNCTION ledger_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous_after numeric(20,2);
        has_any boolean;
      BEGIN
        SELECT balance_after INTO previous_after
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;

        IF FOUND THEN
          IF previous_after <> NEW.balance_before THEN
            RAISE EXCEPTION 'ledger chain broken for wallet %: previous balance_after % <> balance_before %',
              NEW.wallet_id, previous_after, NEW.balance_before USING ERRCODE = 'WG003';
          END IF;
          RETURN NEW;
        END IF;

        -- No previous entry: only valid for the first movement of a wallet opened with 0.00
        -- (version 2) or for the OPENING credit (version 1), always starting from zero.
        SELECT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id) INTO has_any;
        IF has_any OR NEW.wallet_version > 2 OR NEW.balance_before <> 0 THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: missing entry for version %',
            NEW.wallet_id, NEW.wallet_version - 1 USING ERRCODE = 'WG003';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_chain_guard_trg
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_chain_guard();
    `);

    // ------------------------------------------- wallet <-> ledger consistency
    // Immediate: identity columns are immutable and version moves by exactly +1 per balance change.
    this.addSql(`
      CREATE FUNCTION wallet_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets are never deleted (id=%)', OLD.id USING ERRCODE = 'WG003';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet % identity columns are immutable', OLD.id USING ERRCODE = 'WG003';
        END IF;
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet %: balance changed, version must be % (got %)',
            OLD.id, OLD.version + 1, NEW.version USING ERRCODE = 'WG003';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet %: version may only change together with the balance', OLD.id
            USING ERRCODE = 'WG003';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_update_guard_trg
        BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallet_update_guard();
    `);

    // Shared check, run at COMMIT from both sides (wallet changed / entry appended):
    //  - the wallet's current (version, balance) has its ledger entry, and
    //  - no ledger entry is ahead of the wallet ("every balance change has an entry, and vice versa").
    this.addSql(`
      CREATE FUNCTION assert_wallet_matches_ledger(target_wallet uuid) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        current wallets%ROWTYPE;
      BEGIN
        -- Re-read: several statements in one transaction queue several checks; validate final state.
        SELECT * INTO current FROM wallets WHERE id = target_wallet;
        IF NOT FOUND THEN
          RETURN; -- the composite FK reports a missing wallet
        END IF;

        IF EXISTS (
          SELECT 1 FROM wallet_ledger_entries
           WHERE wallet_id = current.id AND wallet_version > current.version
        ) THEN
          RAISE EXCEPTION 'wallet %: ledger has entries beyond wallet version %',
            current.id, current.version USING ERRCODE = 'WG003';
        END IF;

        IF current.version = 1 AND current.balance = 0 THEN
          -- opened with zero balance: there must be no ledger entry at all
          IF EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = current.id) THEN
            RAISE EXCEPTION 'wallet % opened with zero balance has ledger entries', current.id
              USING ERRCODE = 'WG003';
          END IF;
          RETURN;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries
           WHERE wallet_id = current.id
             AND wallet_version = current.version
             AND balance_after = current.balance
        ) THEN
          RAISE EXCEPTION 'wallet % (version %, balance %) has no matching ledger entry',
            current.id, current.version, current.balance USING ERRCODE = 'WG003';
        END IF;
      END;
      $$;
    `);
    this.addSql(`
      CREATE FUNCTION wallet_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM assert_wallet_matches_ledger(NEW.id);
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_consistency_trg
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_consistency();
    `);

    // Deferred to COMMIT (the transaction row may be updated to PROCESSED after the entry is
    // inserted): an entry must belong to a PROCESSED, balance-affecting transaction, carry the
    // same amount/currency, and move in the direction its kind implies.
    this.addSql(`
      CREATE FUNCTION ledger_entry_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        tx wager_transactions%ROWTYPE;
        referenced_direction text;
        expected_direction text;
      BEGIN
        SELECT * INTO tx FROM wager_transactions WHERE id = NEW.transaction_id;
        IF NOT FOUND THEN
          RETURN NULL; -- the composite FK reports a missing transaction
        END IF;

        IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' THEN
          RAISE EXCEPTION 'ledger entry % references transaction % (%/%) that cannot move the balance',
            NEW.id, tx.id, tx.kind, tx.status USING ERRCODE = 'WG003';
        END IF;

        IF tx.amount <> NEW.amount OR tx.currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger entry % amount % % differs from transaction % amount % %',
            NEW.id, NEW.amount, NEW.currency, tx.id, tx.amount, tx.currency USING ERRCODE = 'WG003';
        END IF;

        IF tx.kind = 'BET' THEN
          expected_direction := 'DEBIT';
        ELSIF tx.kind IN ('WIN', 'REFUND', 'OPENING') THEN
          expected_direction := 'CREDIT';
        ELSE -- ROLLBACK: the inverse of the reversed entry
          SELECT direction INTO referenced_direction
            FROM wallet_ledger_entries WHERE transaction_id = tx.reference_transaction_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'ROLLBACK % reverses transaction % that has no ledger entry',
              tx.id, tx.reference_transaction_id USING ERRCODE = 'WG003';
          END IF;
          expected_direction := CASE referenced_direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END;
        END IF;

        IF NEW.direction <> expected_direction THEN
          RAISE EXCEPTION 'ledger entry % for % must be %, got %',
            NEW.id, tx.kind, expected_direction, NEW.direction USING ERRCODE = 'WG003';
        END IF;

        PERFORM assert_wallet_matches_ledger(NEW.wallet_id);
        RETURN NULL;
      END;
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_entry_consistency_trg
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_consistency();
    `);

    // ---------------------------------------------------------- inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  text        NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    text        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0 CONSTRAINT outbox_attempts_chk CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at    timestamptz,
        last_error      text
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_due_idx
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_entry_consistency();`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_ledger_consistency();`);
    this.addSql(`DROP FUNCTION IF EXISTS assert_wallet_matches_ledger(uuid);`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_update_guard();`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_chain_guard();`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_append_only();`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_tx_guard();`);
  }
}
