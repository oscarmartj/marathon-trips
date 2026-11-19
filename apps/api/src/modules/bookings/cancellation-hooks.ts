import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppError } from '../../platform/errors/safe-error';

type Tx = Prisma.TransactionClient;

/**
 * What payments knows about a booking's money before a cancellation (task 6.4, plan sections 2.8 and 13 M4), read with
 * the booking locked and no Payment lock: every change of a payment locks the booking first.
 */
export interface CancellationMoneyFacts {
  /** Succeeded payments − succeeded refunds − withdrawn chargebacks + reinstated (bookingCash). */
  collectedMinor: bigint;
  /** Disputes open or with evidence submitted whose funds are not withdrawn yet: never counted as held. */
  disputedMinor: bigint;
  /** A live attempt in `pending`: a debit already sent to the bank. */
  pendingDebit: boolean;
  /** A refund still on its way: an app refund requested or pending, an external one pending, or a late pending one. */
  refundInFlight: boolean;
  /** A dispute open or with evidence submitted on any payment of the booking. */
  disputeOpen: boolean;
}

/** Payments' side of a cancellation, registered at start-up (bookings cannot import payments, which imports bookings). */
export interface CancellationMoneyPort {
  facts(tx: Tx, bookingId: string): Promise<CancellationMoneyFacts>;
}

@Injectable()
export class BookingCancellationHooks {
  private port: CancellationMoneyPort | null = null;

  registerMoney(port: CancellationMoneyPort): void {
    if (this.port) throw new AppError('cancellation_money_port_duplicate', 'The cancellation money port is already registered');
    this.port = port;
  }

  get money(): CancellationMoneyPort {
    if (!this.port) throw new AppError('cancellation_money_port_missing', 'Cancellations need the payments module');
    return this.port;
  }
}
