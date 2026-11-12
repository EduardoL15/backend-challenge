export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Returns a value in [0, 1). Injected so tests are deterministic. */
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": half of the delay is fixed, half random.
 * `attempt` is 1-based (attempt 1 => between baseMs/2 and baseMs).
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  const half = capped / 2;
  return Math.round(half + random() * half);
}

export function nextAttemptAt(now: Date, attempt: number, options: BackoffOptions): Date {
  return new Date(now.getTime() + computeBackoffMs(attempt, options));
}
