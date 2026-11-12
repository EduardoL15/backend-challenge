import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness: the process is up and the event loop responds. No dependencies checked. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // GET /health/ready (PostgreSQL + SQS reachability) is added in phase 7.
}
