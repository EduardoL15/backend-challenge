import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ENV, type Env } from '../config/env';
import {
  WAGERING_SETTINGS,
  type WageringSettings,
} from '../modules/wagering/application/wager-applier';
import { WAGER_QUERIES } from '../modules/wagering/application/wager-queries';
import { MikroOrmWagerQueries } from '../modules/wagering/infra/persistence/mikro-orm-wager-queries';
import { WALLET_QUERIES } from '../modules/wallet/application/wallet-queries';
import { MikroOrmWalletQueries } from '../modules/wallet/infra/persistence/mikro-orm-wallet-queries';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from '../shared/application/ports';
import { UNIT_OF_WORK } from '../shared/application/unit-of-work';
import { type AppMetrics, METRICS } from '../shared/application/metrics';
import { createOrmConfig } from './persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './persistence/mikro-orm-unit-of-work';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

@Injectable()
class OrmLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('Persistence');
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
    this.logger.log('Database pool closed');
  }
}

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      inject: [ENV],
      useFactory: (env: Env) =>
        MikroORM.init(createOrmConfig({ clientUrl: env.DATABASE_URL, poolMax: env.DB_POOL_MAX })),
    },
    OrmLifecycle,
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, ENV, METRICS],
      useFactory: (orm: MikroORM, env: Env, metrics: AppMetrics) =>
        new MikroOrmUnitOfWork(orm, { lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS }, metrics),
    },
    {
      provide: WAGERING_SETTINGS,
      inject: [ENV],
      useFactory: (env: Env): WageringSettings => ({
        maxReferenceAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
        referenceBackoff: {
          baseMs: env.PENDING_REFERENCE_BASE_MS,
          maxMs: env.PENDING_REFERENCE_MAX_MS,
        },
      }),
    },
    {
      provide: WALLET_QUERIES,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmWalletQueries(orm),
    },
    {
      provide: WAGER_QUERIES,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmWagerQueries(orm),
    },
  ],
  exports: [
    MikroORM,
    CLOCK,
    ID_GENERATOR,
    UNIT_OF_WORK,
    WAGERING_SETTINGS,
    WALLET_QUERIES,
    WAGER_QUERIES,
  ],
})
export class InfrastructureModule {}
