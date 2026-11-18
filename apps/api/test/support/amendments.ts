// Test helpers for changes to a booking after its deposit (task 6.3; plan docs/plans/6.3-booking-amendments.md).
import { AMENDMENT_SETTINGS } from '../../src/modules/bookings';
import { SettingsService } from '../../src/platform/flags/flags.service';
import type { TestApp } from './auth';
import type { CustomerSession } from './owned-route-fixtures';

/** Customers' own changes are off by default (plan review M2); tests that use them switch them on. */
export async function setCustomerAmendments(t: TestApp, on: boolean): Promise<void> {
  await t.app.get(SettingsService).set(AMENDMENT_SETTINGS.customerEnabled.key, on);
}

/**
 * A booking of customer `a` walked to deposit_paid (with its plan), the terms accepted and customers' changes on, and a
 * preview body that adds the package's optional tour for place 1 (a positive difference).
 */
export async function amendableBookingOf(t: TestApp, a: CustomerSession): Promise<{ reference: string; bookingId: string; body: Record<string, unknown> }> {
  const { customerBookingIn } = await import('./customer-portal');
  const { acceptCurrentTerms } = await import('./payments');
  const { reference, bookingId } = await customerBookingIn(t, a, 'deposit_paid');
  await acceptCurrentTerms(t, a, reference);
  await setCustomerAmendments(t, true);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { packageId: true, currentSnapshotVersion: true } });
  const extra = await t.prisma.extra.findFirstOrThrow({ where: { packageId: b.packageId, mandatory: false, deletedAt: null }, select: { id: true } });
  return { reference, bookingId, body: { expectedSnapshotVersion: b.currentSnapshotVersion, extraNightsBefore: 0, extraNightsAfter: 0, extras: [{ extraId: extra.id, travellerSlots: [1] }] } };
}
