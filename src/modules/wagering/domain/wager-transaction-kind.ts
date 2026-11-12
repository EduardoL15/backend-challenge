export enum WagerTransactionKind {
  /** Internal: wallet opening credit. Never accepted from the API or the queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not applied yet. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive. */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied (terminal). */
  Processed = 'PROCESSED',
  /** Business-rule violation (terminal). */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error (terminal, auditable). */
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Which kinds each kind may reference. Kinds missing here may not carry a reference. */
export const ALLOWED_REFERENCE_KINDS: Readonly<
  Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>
> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export const REVERSAL_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);
