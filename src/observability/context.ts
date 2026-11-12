import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Diagnostic context carried implicitly through async calls (one per HTTP request, SQS
 * message or worker item). Every log line written inside it gets these fields for free.
 * Identifiers only: never money, never payloads.
 */
export interface LogContext {
  correlationId?: string;
  requestId?: string;
  messageId?: string;
  sqsMessageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs fn inside a new context that inherits (and overrides) the current one. */
export function withContext<T>(fields: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...definedOnly(fields) }, fn);
}

/** Enriches the CURRENT context in place (e.g. once the transactionId is known). */
export function addContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, definedOnly(fields));
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

function definedOnly(fields: LogContext): LogContext {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
