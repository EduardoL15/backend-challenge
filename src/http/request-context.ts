import { randomUUID } from 'node:crypto';
import {
  createParamDecorator,
  type ExecutionContext as NestExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestMiddleware,
} from '@nestjs/common';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { withContext } from '../observability/context';
import { type AppMetrics, METRICS } from '../shared/application/metrics';
import type { ExecutionContext } from '../shared/application/ports';

export const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** Probes and scrapes: measured, but not logged at info level (noise). */
const QUIET_PATHS = new Set(['/health/live', '/health/ready', '/metrics']);

interface RequestWithContext extends Request {
  executionContext?: ExecutionContext;
}

/**
 * Per HTTP request: correlation id (accepted from the caller when well-formed, echoed back),
 * a diagnostic context for every log line written while handling it, a server span, one
 * access log line and the latency histogram (by route TEMPLATE, never by raw URL).
 */
@Injectable()
export class RequestObservabilityMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  constructor(@Inject(METRICS) private readonly metrics: AppMetrics) {}

  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    const requestId = randomUUID();
    req.executionContext = { correlationId, causationId: requestId };
    res.setHeader('X-Correlation-Id', correlationId);

    const started = performance.now();
    const span = trace.getTracer('wagering-processor').startSpan(`HTTP ${req.method}`, {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': req.method, 'correlation.id': correlationId },
    });

    res.on('finish', () => {
      const route = routeTemplate(req);
      const durationMs = performance.now() - started;
      this.metrics.httpRequest(req.method, route, res.statusCode, durationMs);
      span.updateName(`HTTP ${req.method} ${route}`);
      span.setAttributes({ 'http.route': route, 'http.response.status_code': res.statusCode });
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      if (!QUIET_PATHS.has(req.path)) {
        withContext({ correlationId, requestId }, () => {
          this.logger.log({
            msg: 'HTTP request',
            method: req.method,
            route,
            status: res.statusCode,
            durationMs: Math.round(durationMs),
          });
        });
      }
    });

    // The request span becomes the active span for everything the handlers do.
    withContext({ correlationId, requestId }, () => {
      context.with(trace.setSpan(context.active(), span), next);
    });
  }
}

function routeTemplate(req: Request): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  return typeof routePath === 'string' ? `${req.baseUrl}${routePath}` : 'unmatched';
}

/** Injects the ExecutionContext built by the middleware into a handler parameter. */
export const RequestContext = createParamDecorator(
  (_data: unknown, ctx: NestExecutionContext): ExecutionContext => {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    return req.executionContext ?? { correlationId: randomUUID() };
  },
);
