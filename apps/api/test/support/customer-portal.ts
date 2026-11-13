import { randomUUID } from 'node:crypto';
import type { BookingStatus } from '@mt/shared';
import { STATE_HEADERS } from './auth';
import type { TestApp } from './auth';
import { insertValidSchedule } from './payments';

/** How a booking reaches each status by SQL as the API role (the same steps as payments' booking_money_cells_matrix). */
export const PATH_TO: Record<BookingStatus, BookingStatus[]> = {
  requested: [], approved: ['approved'], deposit_paid: ['approved', 'deposit_paid'], confirmed: ['approved', 'deposit_paid', 'confirmed'],
  balance_paid: ['approved', 'deposit_paid', 'confirmed', 'balance_paid'], completed: ['approved', 'deposit_paid', 'confirmed', 'completed'],
  declined: ['declined'], expired: ['approved', 'expired'], cancelled: ['cancelled'], refunded: ['cancelled', 'refunded'],
};

const STEP = `UPDATE bookings SET status = $2::"BookingStatus", version = version + 1,
  "approvedAt" = CASE WHEN $2 = 'approved' THEN clock_timestamp() ELSE "approvedAt" END,
  "approvalExpiresAt" = CASE WHEN $2 = 'approved' THEN clock_timestamp() + interval '1 day' ELSE "approvalExpiresAt" END,
  "declinedAt" = CASE WHEN $2 = 'declined' THEN clock_timestamp() ELSE "declinedAt" END,
  "expiredAt" = CASE WHEN $2 = 'expired' THEN clock_timestamp() ELSE "expiredAt" END,
  "cancelledAt" = CASE WHEN $2 = 'cancelled' THEN clock_timestamp() ELSE "cancelledAt" END
  WHERE id = $1::uuid`;

/** Walks a requested booking to `to` by SQL (tests about what the customer sees in each status, not about how it got there). */
export async function walkTo(t: TestApp, bookingId: string, to: BookingStatus): Promise<void> {
  for (const s of PATH_TO[to]) {
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(STEP, bookingId, s);
      if (s === 'approved') await insertValidSchedule(tx, bookingId);
      if (s === 'expired') {
        await tx.$executeRawUnsafe(`UPDATE payment_schedule_items SET state = 'superseded', "supersededInVersion" = 2 WHERE "bookingId" = $1::uuid`, bookingId);
        await tx.$executeRawUnsafe(`UPDATE payment_schedules SET version = 2 WHERE "bookingId" = $1::uuid`, bookingId);
      }
    });
  }
}

/** A booking request by the signed-in customer for a fresh priced package, walked to `status`. */
export async function customerBookingIn(t: TestApp, who: { cookie: string }, status: BookingStatus): Promise<{ reference: string; bookingId: string }> {
  const { requestBody } = await import('./bookings');
  const { paymentsStaff } = await import('./payments');
  const { pricedWorld } = await import('./pricing');
  const w = await pricedWorld(await paymentsStaff(t));
  const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', who.cookie).set('Idempotency-Key', randomUUID()).send(requestBody(w));
  if (res.status !== 201) throw new Error(`booking request failed: ${res.status} ${JSON.stringify(res.body)}`);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string }, select: { id: true, reference: true } });
  await walkTo(t, b.id, status);
  return { reference: b.reference, bookingId: b.id };
}
