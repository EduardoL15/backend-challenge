import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../../../http/request-context';
import { parseOrThrow } from '../../../http/validation';
import type { ExecutionContext } from '../../../shared/application/ports';
import type { MoneyProps } from '../../../shared/domain/money';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import {
  LEDGER_PAGE_DEFAULT_LIMIT,
  LEDGER_PAGE_MAX_LIMIT,
  type ReconciliationReport,
  WalletReadUseCases,
} from '../application/wallet-read.use-cases';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export const moneySchema = z.strictObject({
  amount: z.string({ error: 'amount must be a decimal string, e.g. "25.00"' }),
  currency: z.string(),
});

const createWalletSchema = z.strictObject({
  playerId: z.uuid(),
  initialBalance: moneySchema,
});

const walletIdSchema = z.uuid();

const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LEDGER_PAGE_MAX_LIMIT)
    .default(LEDGER_PAGE_DEFAULT_LIMIT),
});

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

const walletView = (w: Wallet): WalletView => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
});

const ledgerEntryView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly reads: WalletReadUseCases,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @RequestContext() ctx: ExecutionContext,
  ): Promise<WalletView> {
    const command = parseOrThrow(createWalletSchema, body, 'body');
    return walletView(await this.createWallet.execute(command, ctx));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return walletView(
      await this.reads.getWallet(parseOrThrow(walletIdSchema, walletId, 'walletId')),
    );
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query() query: unknown,
  ): Promise<{ items: LedgerEntryView[]; nextCursor: string | null }> {
    const id = parseOrThrow(walletIdSchema, walletId, 'walletId');
    const { cursor, limit } = parseOrThrow(ledgerQuerySchema, query, 'query');
    const { page, nextCursor } = await this.reads.getLedger(id, cursor, limit);
    return {
      items: page.items.map(({ entry }) => ledgerEntryView(entry)),
      nextCursor: nextCursor ?? null,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationReport> {
    return this.reads.reconcile(parseOrThrow(walletIdSchema, walletId, 'walletId'));
  }
}
