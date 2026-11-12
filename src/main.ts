import 'reflect-metadata';
import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const env = app.get<Env>(ENV);
  installSignalHandlers(app, env);

  if (env.APP_ROLES.includes('api')) {
    await app.listen(env.PORT);
    logger.log(`HTTP listening on :${env.PORT}`);
  } else {
    await app.init();
  }
  logger.log(`Roles enabled: ${env.APP_ROLES.join(', ')}`);
}

/**
 * Graceful shutdown we control end to end (instead of enableShutdownHooks):
 * app.close() runs the hooks in order (consumer/workers finish or give work back, then the
 * HTTP server, SQS client and DB pool close) and then we EXIT. Without the explicit exit, a
 * half-closed socket (e.g. an aborted SQS long poll) kept the process alive ~20s on Bun.
 * A hard deadline guarantees we never hang past the orchestrator's kill timeout.
 */
function installSignalHandlers(app: INestApplication, env: Env): void {
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
