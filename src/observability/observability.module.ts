import { hostname } from 'node:os';
import { Controller, Get, Global, Module, Res } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import type { Response } from 'express';
import { Public } from '../modules/auth/auth';
import { METRICS } from '../shared/application/metrics';
import { PrometheusMetrics } from './prometheus-metrics';

/** Prometheus scrape endpoint (unauthenticated like health; expose only on the internal network). */
@Public()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get('metrics')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: PrometheusMetrics,
      inject: [ENV],
      useFactory: (env: Env) =>
        new PrometheusMetrics(
          env.METRICS_INSTANCE_LABEL ? { instance: process.env.HOSTNAME ?? hostname() } : {},
        ),
    },
    { provide: METRICS, useExisting: PrometheusMetrics },
  ],
  exports: [PrometheusMetrics, METRICS],
})
export class ObservabilityModule {}
