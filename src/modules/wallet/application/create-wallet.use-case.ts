import { Inject, Injectable } from '@nestjs/common';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import {
  ConflictError,
  ErrorCodes,
  UniqueViolationError,
} from '../../../shared/application/errors';
import { eventContextFactory } from '../../../shared/application/event-context';
import {
  CLOCK,
  type Clock,
  type ExecutionContext,
  ID_GENERATOR,
  type IdGenerator,
} from '../../../shared/application/ports';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/application/unit-of-work';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { Wallet } from '../domain/wallet';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/**
 * Opens a wallet. A positive initial balance becomes an internal OPENING transaction with its
 * CREDIT ledger entry, in the SAME SQL transaction as the wallet row.
 */
@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand, ctx: ExecutionContext): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    const newEventContext = eventContextFactory(this.ids, this.clock, ctx);

    try {
      return await this.uow.run(async (repos) => {
        const existing = await repos.wallets.findByPlayerAndCurrency(
          command.playerId,
          initialBalance.currency,
        );
        if (existing) throw walletAlreadyExists();

        const at = this.clock.now();
        const walletId = this.ids.next();
        const opening = WagerTransaction.createOpening({
          id: this.ids.next(),
          walletId,
          playerId: command.playerId,
          money: initialBalance,
          at,
        });
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId: opening.id,
          openingEntryId: this.ids.next(),
          at,
        });

        repos.wallets.add(wallet);
        if (openingEntry) {
          opening.markProcessed(undefined, at, wallet.balance);
          repos.wagers.add(opening);
          repos.ledger.append(openingEntry);
          repos.outbox.add(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, newEventContext()),
            ),
          );
        }
        return wallet;
      });
    } catch (error) {
      // Two concurrent creations for the same player+currency: the schema decides the winner.
      if (
        error instanceof UniqueViolationError &&
        error.constraint === 'wallets_player_currency_uq'
      ) {
        throw walletAlreadyExists();
      }
      throw error;
    }
  }
}

function walletAlreadyExists(): ConflictError {
  return new ConflictError(
    ErrorCodes.WalletAlreadyExists,
    'A wallet already exists for this player and currency',
  );
}
