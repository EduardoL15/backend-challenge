import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  Controller,
  Get,
  Inject,
  Injectable,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ENV, type Env } from '../config/env';
import { Public } from '../modules/auth/auth';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../modules/messaging/infra/sqs/sqs';

const CHECK_TIMEOUT_MS = 2_000;

type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { database: CheckStatus; sqs: CheckStatus };
  draining: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`timed out after ${String(ms)}ms`));
      }, ms);
    }),
  ]);
}

@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  private draining = false;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** From the first moment of shutdown we report "not ready", so traffic is drained away. */
  beforeApplicationShutdown(): void {
    this.draining = true;
  }

  async readiness(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([this.checkDatabase(), this.checkSqs()]);
    const ready = database === 'up' && sqs === 'up' && !this.draining;
    return {
      status: ready ? 'ok' : 'unavailable',
      checks: { database, sqs },
      draining: this.draining,
    };
  }

  private async checkDatabase(): Promise<CheckStatus> {
    try {
      await withTimeout(this.orm.em.fork().execute('SELECT 1'), CHECK_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  /** A real round trip every time (the queue URL itself is cached, so it proves nothing). */
  private async checkSqs(): Promise<CheckStatus> {
    try {
      const queueUrl = await withTimeout(
        this.queues.get(this.env.SQS_WAGER_QUEUE_NAME),
        CHECK_TIMEOUT_MS,
      );
      await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
        { abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
      );
      return 'up';
    } catch {
      return 'down';
    }
  }
}

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is up and the event loop responds. No dependencies checked. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS reachable, and not shutting down. 503 otherwise. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
