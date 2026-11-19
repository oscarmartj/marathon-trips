import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import type { LockedPayment } from './attempt-state';

type Tx = Prisma.TransactionClient;

/** What a hook is told about a confirmed or voided bank transfer. */
export type InboundPayment = Pick<LockedPayment, 'id' | 'bookingId' | 'amountMinor' | 'currency' | 'mode' | 'providerAccountId'>;
export type InboundHook = (tx: Tx, payment: InboundPayment) => Promise<void>;

/**
 * Where other money records (the ledger of task 3.3) follow a bank transfer (task 3.4, plan section 4). Hooks run in the
 * transaction that confirms or voids the transfer, with the booking and the payment locked; a hook that throws undoes
 * the whole change, so a transfer is never recorded without its entries. Registered by name, once.
 */
@Injectable()
export class InboundPaymentHooks {
  private readonly confirmed = new Map<string, InboundHook>();
  private readonly voided = new Map<string, InboundHook>();

  onConfirmed(name: string, fn: InboundHook): void {
    if (this.confirmed.has(name)) throw new Error(`inbound confirmed hook ${name} already registered`);
    this.confirmed.set(name, fn);
  }

  onVoided(name: string, fn: InboundHook): void {
    if (this.voided.has(name)) throw new Error(`inbound voided hook ${name} already registered`);
    this.voided.set(name, fn);
  }

  async runConfirmed(tx: Tx, p: InboundPayment): Promise<void> {
    for (const fn of this.confirmed.values()) await fn(tx, p);
  }

  async runVoided(tx: Tx, p: InboundPayment): Promise<void> {
    for (const fn of this.voided.values()) await fn(tx, p);
  }
}
