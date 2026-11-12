import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import { PollingLoop } from '../../../infrastructure/workers/polling-loop';
import { OutboxRelay } from '../application/outbox-relay';

export const OUTBOX_RELAY = Symbol('OutboxRelay');

/** Role "outbox": any number of instances may run it at the same time (SKIP LOCKED). */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('OutboxPublisher');
  private readonly loop: PollingLoop;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(OUTBOX_RELAY) private readonly relay: OutboxRelay,
  ) {
    this.loop = new PollingLoop({
      name: 'OutboxPublisher',
      idleIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      iterate: async () => {
        const { handled, failed } = await this.relay.relayOnce();
        if (failed > 0) this.logger.warn({ msg: 'Some events failed to publish', failed, handled });
        // A full batch means there is probably more waiting; failures wait for their backoff.
        return handled >= env.OUTBOX_BATCH_SIZE && failed === 0;
      },
    });
  }

  onApplicationBootstrap(): void {
    if (this.env.APP_ROLES.includes('outbox')) this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop(this.env.SHUTDOWN_GRACE_MS);
  }
}
