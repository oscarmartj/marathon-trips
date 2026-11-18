import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuditActor } from '../../platform/audit/audit.service';
import { AppError } from '../../platform/errors/safe-error';
import type { LockedBooking } from './read';

type Tx = Prisma.TransactionClient;

/** What payments knows about a booking's money before a change (read with the booking locked; no Payment lock). */
export interface AmendmentMoneyFacts {
  collectedMinor: bigint;
  /** A payment attempt is in progress: its amount was computed for the current plan (plan, decision 7). */
  liveAttempt: boolean;
}

export interface AmendmentPlanContext {
  actor: AuditActor;
  reference: string;
  previousTotalMinor: bigint;
  newTotalMinor: bigint;
  toVersion: number;
  /** YYYY-MM-DD (Brisbane): when what the change adds is due (plan section 6). */
  adjustmentDue: string;
}

/** What the change left the booking owing or owed, derived by payments right after it restated the plan. */
export interface AmendmentMoneyAfter {
  collectedMinor: bigint;
  outstandingMinor: bigint;
  creditPendingMinor: bigint;
}

/** Payments' side of a change (registered by the payments module; plan section 6). */
export interface AmendmentMoneyPort {
  facts(tx: Tx, bookingId: string): Promise<AmendmentMoneyFacts>;
  /** Restates the plan for the new total, revokes links, applies coverage C and keeps the credit task in step. */
  restate(tx: Tx, booking: LockedBooking, ctx: AmendmentPlanContext): Promise<AmendmentMoneyAfter>;
}

export interface AmendmentPlacesContext {
  actor: AuditActor;
  bookingId: string;
  customerId: string;
  /** New places that replace an old one, whose details are carried (plan section 7). */
  carries: Array<{ from: number; to: number; runner: boolean }>;
  /** Places this change removed or replaced: their details are deleted. */
  retired: number[];
}

/** Customer-portal's side of a change: traveller details of replaced and retired places (plan section 7). */
export type AmendmentPlacesHook = (tx: Tx, ctx: AmendmentPlacesContext) => Promise<void>;

/**
 * The other modules' steps inside a change of a booking, in its transaction, with the booking locked (plan sections 5 to
 * 7). Bookings cannot import payments or customer-portal (they import bookings), so they register here at start-up. A
 * change refuses to run without the money port: a plan that does not follow the total would fail at commit anyway.
 */
@Injectable()
export class BookingAmendmentHooks {
  private moneyPort: AmendmentMoneyPort | null = null;
  private readonly places: AmendmentPlacesHook[] = [];

  registerMoney(port: AmendmentMoneyPort): void {
    if (this.moneyPort) throw new AppError('amendment_money_port_duplicate', 'The amendment money port is already registered');
    this.moneyPort = port;
  }

  registerPlaces(hook: AmendmentPlacesHook): void {
    this.places.push(hook);
  }

  get money(): AmendmentMoneyPort {
    if (!this.moneyPort) throw new AppError('amendment_money_port_missing', 'Changes to bookings need the payments module');
    return this.moneyPort;
  }

  async runPlaces(tx: Tx, ctx: AmendmentPlacesContext): Promise<void> {
    for (const hook of this.places) await hook(tx, ctx);
  }
}
