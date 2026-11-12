import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuditActor } from '../../platform/audit/audit.service';
import { AppError } from '../../platform/errors/safe-error';

export interface HookedBooking {
  id: string;
  customerId: string;
  packageId: string;
  currency: string;
  /** The status before the transition. */
  from: string;
}

export type BookingHook = (tx: Prisma.TransactionClient, booking: HookedBooking, ctx: { actor: AuditActor; at: Date }) => Promise<void>;

/**
 * Synchronous steps another module runs inside a booking transition, in its transaction, with the booking locked
 * (plan 0.1, 6.2: "in the same transaction payments creates the payment plan"). Task 2.4 registers none; task 3.1
 * registers the payment plan on approval and its change on cancellation. A hook that throws aborts the transition.
 */
@Injectable()
export class BookingTransitionHooks {
  private readonly hooks = { approve: new Map<string, BookingHook>(), cancel: new Map<string, BookingHook>() };

  register(event: 'approve' | 'cancel', name: string, hook: BookingHook): void {
    const map = this.hooks[event];
    if (map.has(name)) throw new AppError('booking_hook_duplicate', `Booking hook ${name} is already registered`);
    map.set(name, hook);
  }

  async run(event: 'approve' | 'cancel', tx: Prisma.TransactionClient, booking: HookedBooking, ctx: { actor: AuditActor; at: Date }): Promise<void> {
    for (const hook of this.hooks[event].values()) await hook(tx, booking, ctx);
  }
}
