import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();

  const env = app.get<Env>(ENV);
  const logger = new Logger('Bootstrap');

  if (env.APP_ROLES.includes('api')) {
    await app.listen(env.PORT);
    logger.log(`HTTP listening on :${env.PORT}`);
  } else {
    await app.init();
  }
  logger.log(`Roles enabled: ${env.APP_ROLES.join(', ')}`);
}

bootstrap().catch((error: unknown) => {
  // Fail fast and loudly (invalid env, unreachable dependency...): the orchestrator restarts us.
  new Logger('Bootstrap').error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
