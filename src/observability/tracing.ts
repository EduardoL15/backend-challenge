import { type Attributes, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const TRACER_NAME = 'wagering-processor';

/**
 * Optional OpenTelemetry tracing, enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Spans are created manually at the meaningful boundaries (HTTP request, SQS message,
 * use case, outbox batch): automatic http/pg instrumentation relies on Node module hooks
 * that are not reliable under Bun. Without a provider, every span is a cheap no-op.
 */
export function initTracing(
  endpoint: string | undefined,
  serviceName: string,
): {
  shutdown: () => Promise<void>;
} {
  if (!endpoint) return { shutdown: () => Promise.resolve() };
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      ),
    ],
  });
  provider.register(); // also installs the AsyncLocalStorage context manager
  return { shutdown: () => provider.shutdown() };
}

/** Runs fn inside an active span; records exceptions and marks the span as failed. */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function setSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
