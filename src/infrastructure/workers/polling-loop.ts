import { Logger } from '@nestjs/common';

export interface PollingLoopOptions {
  name: string;
  /** Pause between iterations that found nothing (or less than a full batch) to do. */
  idleIntervalMs: number;
  /** One iteration; returns true when there may be more work right away (full batch). */
  iterate: () => Promise<boolean>;
}

/**
 * Background loop used by the outbox publisher and the PENDING_REFERENCE worker.
 * stop() interrupts the idle sleep immediately and waits (bounded) for the current
 * iteration, so a SIGTERM never cuts a database transaction in half on purpose.
 */
export class PollingLoop {
  private readonly logger: Logger;
  private stopping = false;
  private running: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly options: PollingLoopOptions) {
    this.logger = new Logger(options.name);
  }

  start(): void {
    if (this.running) return;
    this.running = this.loop();
    this.logger.log('Started');
  }

  async stop(graceMs: number): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.wakeUp?.();
    const finished = await Promise.race([
      this.running.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, graceMs);
      }),
    ]);
    if (finished) this.logger.log('Stopped gracefully');
    else this.logger.warn('Grace period elapsed with an iteration still running');
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private async loop(): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.isStopping()) {
      let more = false;
      try {
        more = await this.options.iterate();
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors++;
        this.logger.warn({ msg: 'Iteration failed', consecutiveErrors, error: String(error) });
      }
      if (more || this.isStopping()) continue;
      const pause =
        consecutiveErrors === 0
          ? this.options.idleIntervalMs
          : Math.min(30_000, this.options.idleIntervalMs * 2 ** Math.min(consecutiveErrors, 6));
      await this.sleep(pause);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }
}
