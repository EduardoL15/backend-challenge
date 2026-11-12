/**
 * Application-level errors. Each one maps to exactly one HTTP status class, so a provider
 * never has to parse a message to decide whether it may resend:
 *
 *   ValidationError                400  fix the payload, do not resend as is
 *   NotFoundError                  404
 *   ConflictError                  409  idempotency conflict / duplicate wallet, do not resend
 *   DomainError (business)         422  terminal business rejection (carries a FailureCode)
 *   TransientInfrastructureError   503  safe to retry with the same Idempotency-Key
 */
export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends ApplicationError {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[] = [],
  ) {
    super('INVALID_PAYLOAD', message);
  }
}

export class NotFoundError extends ApplicationError {}

export class ConflictError extends ApplicationError {}

/** Lock timeout, deadlock, serialization failure, connection loss... Retry is safe. */
export class TransientInfrastructureError extends ApplicationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('TRANSIENT_FAILURE', message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A unique constraint fired at COMMIT: the caller decides whether this is a race to retry. */
export class UniqueViolationError extends ApplicationError {
  constructor(public readonly constraint: string | undefined) {
    super('UNIQUE_VIOLATION', `Unique constraint violated: ${constraint ?? 'unknown'}`);
  }
}

export const ErrorCodes = {
  WalletNotFound: 'WALLET_NOT_FOUND',
  WalletAlreadyExists: 'WALLET_ALREADY_EXISTS',
  TransactionNotFound: 'TRANSACTION_NOT_FOUND',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
} as const;
