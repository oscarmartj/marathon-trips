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

export interface BookingHookContext {
  actor: AuditActor;
  at: Date;
  /** On approval: when the approval will expire (task 3.1 dates the deposit from it). */
  approvalExpiresAt?: Date | null;
}

export type BookingHook = (tx: Prisma.TransactionClient, booking: HookedBooking, ctx: BookingHookContext) => Promise<void>;

/** Events other modules can hook into (tasks 3.1 and 3.2). The coverage events have no hooks: nothing recurses. */
export type HookedEvent = 'approve' | 'cancel' | 'confirm' | 'expire_approval';
/** `before` runs with the booking locked before the status changes; `after` once the new status is written. */
export type HookPhase = 'before' | 'after';

/**
 * Synchronous steps another module runs inside a booking transition, in its transaction, with the booking locked
 * (plan 0.1, 6.2: "in the same transaction payments creates the payment plan"). Task 3.1 registers the payment plan on
 * approval and its change on cancellation; task 3.2 the deposit check on confirmation, the plan on approval expiry and
 * the coverage rule after approval and confirmation. A hook that throws aborts the transition.
 */
@Injectable()
export class BookingTransitionHooks {
  private readonly hooks = new Map<string, Map<string, BookingHook>>();

  register(event: HookedEvent, name: string, hook: BookingHook, phase: HookPhase = 'before'): void {
    const key = `${phase}:${event}`;
    const map = this.hooks.get(key) ?? new Map<string, BookingHook>();
    if (map.has(name)) throw new AppError('booking_hook_duplicate', `Booking hook ${name} is already registered`);
    map.set(name, hook);
    this.hooks.set(key, map);
  }

  async run(event: HookedEvent, tx: Prisma.TransactionClient, booking: HookedBooking, ctx: BookingHookContext, phase: HookPhase = 'before'): Promise<void> {
    for (const hook of this.hooks.get(`${phase}:${event}`)?.values() ?? []) await hook(tx, booking, ctx);
  }
}
