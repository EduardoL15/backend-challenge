import { Controller, Get, Global, Module, Res } from '@nestjs/common';
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
    { provide: PrometheusMetrics, useFactory: () => new PrometheusMetrics() },
    { provide: METRICS, useExisting: PrometheusMetrics },
  ],
  exports: [PrometheusMetrics, METRICS],
})
export class ObservabilityModule {}
