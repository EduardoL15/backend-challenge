import { Module } from '@nestjs/common';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { WalletReadUseCases } from './application/wallet-read.use-cases';
import { WalletController } from './http/wallet.controller';

@Module({
  controllers: [WalletController],
  providers: [CreateWalletUseCase, WalletReadUseCases],
})
export class WalletModule {}
