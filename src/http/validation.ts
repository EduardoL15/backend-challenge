import type { z } from 'zod';
import { ValidationError } from '../shared/application/errors';

/** Parses untrusted input with a Zod schema; failures become a 400 INVALID_PAYLOAD. */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  what: string,
): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(
    `Invalid ${what}`,
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || what,
      message: issue.message,
    })),
  );
}
