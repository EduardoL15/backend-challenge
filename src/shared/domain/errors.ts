import { FailureCode } from './failure-code';

/** Business-rule violation. Carries a stable FailureCode. */
export class DomainError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(FailureCode.InvalidAmount, message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(FailureCode.CurrencyMismatch, `Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super(FailureCode.InsufficientFunds, 'Insufficient funds');
  }
}

/**
 * Programming error: an illegal state transition (e.g. touching a terminal transaction).
 * Deliberately NOT a DomainError, so it is never mapped to a business response.
 */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

/** Programming error: an invariant the code itself should have guaranteed was broken. */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}
