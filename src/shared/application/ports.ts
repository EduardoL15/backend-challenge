/** Time source. Injected so tests and replays are deterministic. */
export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('Clock');

/** Generates time-ordered ids (UUIDv7): index-friendly and sortable by creation time. */
export interface IdGenerator {
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

/** Per-request/per-message context propagated to events and logs. */
export interface ExecutionContext {
  correlationId: string;
  /** What caused this execution (SQS messageId, HTTP request id...). */
  causationId?: string;
}
