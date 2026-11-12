/**
 * Stable, machine-readable failure codes. Providers use them to decide whether
 * to resend, fix the payload or give up. Never rename a published code.
 */
export const FailureCode = {
  // Contract / payload (fix the request)
  InvalidPayload: 'INVALID_PAYLOAD',
  InvalidAmount: 'INVALID_AMOUNT',
  InternalKindNotAllowed: 'INTERNAL_KIND_NOT_ALLOWED',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',

  // Business rules (terminal, do not resend)
  WalletNotFound: 'WALLET_NOT_FOUND',
  PlayerWalletMismatch: 'PLAYER_WALLET_MISMATCH',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed: 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  ReversalAmountMismatch: 'REVERSAL_AMOUNT_MISMATCH',

  // Infrastructure (FAILED status, auditable)
  PermanentInfrastructureError: 'PERMANENT_INFRASTRUCTURE_ERROR',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
