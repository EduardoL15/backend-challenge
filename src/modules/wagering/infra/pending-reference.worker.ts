import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import { PollingLoop } from '../../../infrastructure/workers/polling-loop';
import { CLOCK, type Clock } from '../../../shared/application/ports';
import { ResolvePendingReferenceUseCase } from '../application/resolve-pending-reference.use-case';
import { WAGER_QUERIES, type WagerQueries } from '../application/wager-queries';

/**
 * Role "pending": re-evaluates PENDING_REFERENCE transactions whose backoff slot is due.
 * Safe with several instances: each candidate is re-checked under its wallet lock.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('PendingReferenceWorker');
  private readonly loop: PollingLoop;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WAGER_QUERIES) private readonly queries: WagerQueries,
    private readonly resolver: ResolvePendingReferenceUseCase,
  ) {
    this.loop = new PollingLoop({
      name: 'PendingReferenceWorker',
      idleIntervalMs: env.PENDING_POLL_INTERVAL_MS,
      iterate: () => this.iterate(),
    });
  }

  onApplicationBootstrap(): void {
    if (this.env.APP_ROLES.includes('pending')) this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop(this.env.SHUTDOWN_GRACE_MS);
  }

  private async iterate(): Promise<boolean> {
    const ids = await this.queries.findDuePendingReferenceIds(
      this.clock.now(),
      this.env.PENDING_BATCH_SIZE,
    );
    // Different wallets in parallel; the same wallet is serialized by its row lock.
    const results = await Promise.allSettled(ids.map((id) => this.resolver.resolve(id)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        this.logger.warn({
          msg: 'Pending reference resolution failed (will retry)',
          transactionId: ids[i],
          error: String(result.reason),
        });
      } else if (result.value === 'resolved') {
        this.logger.log({ msg: 'Pending reference resolved', transactionId: ids[i] });
      }
    });
    return ids.length >= this.env.PENDING_BATCH_SIZE;
  }
}
