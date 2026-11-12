import type { EventContext } from '../domain/integration-event';
import type { Clock, ExecutionContext, IdGenerator } from './ports';

/** Builds a fresh EventContext (new eventId) for each event emitted in one execution. */
export function eventContextFactory(
  ids: IdGenerator,
  clock: Clock,
  ctx: ExecutionContext,
): () => EventContext {
  return () => ({
    eventId: ids.next(),
    correlationId: ctx.correlationId,
    ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
    occurredAt: clock.now(),
  });
}
