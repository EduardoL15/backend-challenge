import { EntitySchema } from '@mikro-orm/core';

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  resultBalanceCurrency?: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
  processedAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

const ts = (fieldName: string, nullable = false) =>
  ({ type: 'datetime', columnType: 'timestamptz', fieldName, nullable }) as const;

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text', fieldName: 'provider_id' },
    externalTransactionId: { type: 'text', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'text', fieldName: 'idempotency_key' },
    payloadHash: { type: 'text', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'text', fieldName: 'round_id' },
    gameId: { type: 'text', fieldName: 'game_id' },
    kind: { type: 'text' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: {
      type: 'text',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', fieldName: 'failure_code', nullable: true },
    resultBalance: {
      type: 'decimal',
      columnType: 'numeric(20,2)',
      fieldName: 'result_balance',
      nullable: true,
    },
    resultBalanceCurrency: {
      type: 'string',
      columnType: 'char(3)',
      fieldName: 'result_balance_currency',
      nullable: true,
    },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: ts('next_reference_attempt_at', true),
    processedAt: ts('processed_at', true),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
});
