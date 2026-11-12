import 'reflect-metadata';
import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { type Env, loadEnv } from './config/env';
import { PinoNestLogger, createRootLogger } from './observability/logger';
import { initTracing } from './observability/tracing';

const SERVICE_NAME = 'wagering-processor';
const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  // Tracing must be registered before any span is created.
  const tracing = initTracing(env.OTEL_EXPORTER_OTLP_ENDPOINT, SERVICE_NAME);
  const app = await NestFactory.create(AppModule, {
    logger: new PinoNestLogger(createRootLogger({ level: env.LOG_LEVEL, service: SERVICE_NAME })),
  });
  installSignalHandlers(app, env, tracing.shutdown);

  if (env.APP_ROLES.includes('api')) {
    await app.listen(env.PORT);
    logger.log(`HTTP listening on :${String(env.PORT)}`);
  } else {
    await app.init();
  }
  logger.log({
    msg: 'Started',
    roles: env.APP_ROLES,
    tracing: env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined,
  });
}

/**
 * Graceful shutdown we control end to end (instead of enableShutdownHooks):
 * app.close() runs the hooks in order (readiness flips to 503, consumer/workers finish or
 * give work back, then the HTTP server, SQS client and DB pool close), pending spans are
 * flushed and then we EXIT. Without the explicit exit, a half-closed socket (an aborted
 * SQS long poll) kept the process alive ~20s on Bun. A hard deadline guarantees we never
 * hang past the orchestrator's kill timeout.
 */
function installSignalHandlers(
  app: INestApplication,
  env: Env,
  flushTraces: () => Promise<void>,
): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} received, shutting down`);
    const deadline = setTimeout(() => {
      logger.error('Shutdown deadline exceeded, forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_GRACE_MS + 5_000);
    deadline.unref();

    app
      .close()
      .then(() => flushTraces())
      .then(() => {
        logger.log('Shutdown complete');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

bootstrap().catch((error: unknown) => {
  // Fail fast and loudly (invalid env, unreachable dependency...): the orchestrator restarts us.
  logger.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
