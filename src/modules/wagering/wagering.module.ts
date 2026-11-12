import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { WagerReadUseCases } from './application/wager-queries';
import { WageringController } from './http/wagering.controller';
import { WagerTransactionConsumer } from './infra/sqs/wager-transaction.consumer';

@Module({
  imports: [AuthModule],
  controllers: [WageringController],
  // The consumer only starts polling when APP_ROLES contains "consumer".
  providers: [ProcessWagerTransactionUseCase, WagerReadUseCases, WagerTransactionConsumer],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
