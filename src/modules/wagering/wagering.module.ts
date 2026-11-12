import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { WagerReadUseCases } from './application/wager-queries';
import { WageringController } from './http/wagering.controller';

@Module({
  imports: [AuthModule],
  controllers: [WageringController],
  providers: [ProcessWagerTransactionUseCase, WagerReadUseCases],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
