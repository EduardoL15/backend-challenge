import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { ResolvePendingReferenceUseCase } from './application/resolve-pending-reference.use-case';
import { WagerApplier } from './application/wager-applier';
import { WagerReadUseCases } from './application/wager-queries';
import { WageringController } from './http/wagering.controller';
import { PendingReferenceWorker } from './infra/pending-reference.worker';
import { WagerTransactionConsumer } from './infra/sqs/wager-transaction.consumer';

@Module({
  imports: [AuthModule],
  controllers: [WageringController],
  // Background components only start when APP_ROLES contains their role.
  providers: [
    WagerApplier,
    ProcessWagerTransactionUseCase,
    ResolvePendingReferenceUseCase,
    WagerReadUseCases,
    WagerTransactionConsumer,
    PendingReferenceWorker,
  ],
  exports: [ProcessWagerTransactionUseCase, ResolvePendingReferenceUseCase],
})
export class WageringModule {}
