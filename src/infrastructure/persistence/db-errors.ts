import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import {
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../shared/application/errors';

/**
 * SQLSTATEs that mean "try again later": the operation did not happen (the transaction was
 * rolled back), so a retry with the same Idempotency-Key is safe.
 */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export type LockFailureKind = 'lock_timeout' | 'deadlock' | undefined;

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isTransientDbError(error: unknown): boolean {
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return true;
  }
  const code = codeOf(error);
  if (code === undefined) return false;
  return TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NODE_CODES.has(code);
}

/** Used for the lock-conflict metric. */
export function lockFailureKind(error: unknown): LockFailureKind {
  const code = codeOf(error);
  if (code === '55P03' || error instanceof LockWaitTimeoutException) return 'lock_timeout';
  if (code === '40P01' || error instanceof DeadlockException) return 'deadlock';
  return undefined;
}

/** Translates driver errors into application errors; anything else is rethrown untouched. */
export function translateDbError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException || codeOf(error) === '23505') {
    const constraint = (error as { constraint?: unknown }).constraint;
    return new UniqueViolationError(typeof constraint === 'string' ? constraint : undefined);
  }
  if (isTransientDbError(error)) {
    return new TransientInfrastructureError('Database temporarily unavailable', { cause: error });
  }
  return error;
}
