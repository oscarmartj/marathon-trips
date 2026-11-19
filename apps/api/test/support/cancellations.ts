// Task 6.4: cancellation policies and cancellations in tests (plan docs/plans/6.4-cancellation-policies.md).
import { randomUUID } from 'node:crypto';
import { CANCELLATION_SETTINGS } from '../../src/modules/bookings';
import { SettingsService } from '../../src/platform/flags/flags.service';
import { STATE_HEADERS } from './auth';
import type { TestApp } from './auth';
import type { CustomerSession } from './owned-route-fixtures';
import type { Client } from './catalogue';
import { must } from './pricing';

export interface TierBody {
  minDaysBeforeDeparture: number;
  penaltyMode: 'percent' | 'fixed_per_person' | 'fixed_per_booking';
  penaltyBps: number | null;
  penaltyMinor: string | null;
  currency: 'AUD' | null;
}

export const pct = (minDaysBeforeDeparture: number, penaltyBps: number): TierBody => ({ minDaysBeforeDeparture, penaltyMode: 'percent', penaltyBps, penaltyMinor: null, currency: null });
export const perPerson = (minDaysBeforeDeparture: number, minor: bigint): TierBody => ({ minDaysBeforeDeparture, penaltyMode: 'fixed_per_person', penaltyBps: null, penaltyMinor: minor.toString(), currency: 'AUD' });
export const perBooking = (minDaysBeforeDeparture: number, minor: bigint): TierBody => ({ minDaysBeforeDeparture, penaltyMode: 'fixed_per_booking', penaltyBps: null, penaltyMinor: minor.toString(), currency: 'AUD' });

/** The plan's four-tier policy (section 10): 60 d 10 %, 30 d 50 %, 14 d A$500 per person, 0 d 100 %. */
export const FOUR_TIERS: TierBody[] = [pct(60, 1000), pct(30, 5000), perPerson(14, 50_000n), pct(0, 10_000)];

/** A draft with these tiers, activated (the staff client needs the pricing permissions and a recent TOTP check). */
export async function activePolicy(admin: Client, tiers: TierBody[] = FOUR_TIERS): Promise<{ id: string; digest: string }> {
  const p = (await must(admin.post('/admin/pricing/cancellation-policies', { name: `Policy ${randomUUID().slice(0, 8)}`, description: { 'en-AU': 'Test cancellation policy' } }), 'policy', 201)).body;
  const withTiers = (await must(admin.put(`/admin/pricing/cancellation-policies/${p.id}/tiers`, { version: p.version, tiers }), 'tiers')).body;
  const active = (await must(admin.post(`/admin/pricing/cancellation-policies/${p.id}/activate`, { version: withTiers.version }), 'activate')).body;
  return { id: active.id as string, digest: active.digest as string };
}

export async function assignPolicy(admin: Client, packageId: string, policyId: string | null): Promise<void> {
  const cur = (await must(admin.get(`/admin/pricing/packages/${packageId}/cancellation-policy`), 'assignment')).body;
  await must(admin.put(`/admin/pricing/packages/${packageId}/cancellation-policy`, { policyId, version: cur.version }), 'assign');
}

export async function setCustomerCancellations(t: TestApp, on: boolean): Promise<void> {
  await t.app.get(SettingsService).set(CANCELLATION_SETTINGS.customerEnabled.key, on);
}

/** What the public page shows for a package, as the request sends it back. */
export async function shownPolicy(t: TestApp, packageId: string): Promise<{ id: string; digest: string } | null> {
  const r = await t.http().get(`/pricing/packages/${packageId}/cancellation-policy`);
  if (r.status !== 200) throw new Error(`public policy failed: ${r.status}`);
  return r.body.policy ? { id: r.body.policy.id, digest: r.body.policy.digest } : null;
}

/**
 * A booking request of customer `who` for a fresh priced package sold under a new active policy, walked to `status`
 * (SQL, with its plan; nothing paid). Returns the world's ids too.
 */
export async function policyBookingOf(t: TestApp, who: CustomerSession | { cookie: string }, status: 'requested' | 'approved' | 'deposit_paid' | 'confirmed' | 'balance_paid' = 'deposit_paid', tiers: TierBody[] = FOUR_TIERS) {
  const { requestBody } = await import('./bookings');
  const { paymentsStaff } = await import('./payments');
  const { pricedWorld } = await import('./pricing');
  const { walkTo } = await import('./customer-portal');
  const staff = await paymentsStaff(t);
  const w = await pricedWorld(staff);
  const policy = await activePolicy(staff, tiers);
  await assignPolicy(staff, w.pkg.id, policy.id);
  const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', who.cookie).set('Idempotency-Key', randomUUID()).send(requestBody(w, { cancellationPolicy: policy }));
  if (res.status !== 201) throw new Error(`booking request failed: ${res.status} ${JSON.stringify(res.body)}`);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string }, select: { id: true, reference: true } });
  if (status !== 'requested') await walkTo(t, b.id, status);
  return { reference: b.reference, bookingId: b.id, policy, world: w, staff };
}
