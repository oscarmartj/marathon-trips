import { randomBytes } from 'node:crypto';
import type { BookingStatus } from '@mt/shared';
import { STATE_HEADERS, createStaff, signInStaff, uniqueEmail } from './auth';
import type { StaffFixture, TestApp } from './auth';
import { walkTo } from './customer-portal';

export const PRIVACY_ALL = ['privacy.customer.read', 'privacy.customer.export', 'privacy.customer.erase'];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const reference = () => `MT-${Array.from(randomBytes(6), (b) => CROCKFORD[b & 31]).join('')}`;
const hex64 = () => randomBytes(32).toString('hex');

export interface StaffHttp {
  staff: StaffFixture;
  cookie: string;
  get: (path: string) => ReturnType<ReturnType<TestApp['http']>['get']>;
  post: (path: string, body?: object) => ReturnType<ReturnType<TestApp['http']>['post']>;
}

/** A signed-in staff member (owner, or a custom role with these permissions); signing in counts as a fresh step-up. */
export async function privacyStaff(t: TestApp, opts: { owner?: boolean; permissions?: string[] } = {}): Promise<StaffHttp> {
  const staff = await createStaff(t, opts.owner ? { owner: true } : { permissions: opts.permissions ?? PRIVACY_ALL });
  const cookie = await signInStaff(t, staff);
  return {
    staff, cookie,
    get: (path) => t.http().get(path).set('Cookie', cookie),
    post: (path, body = {}) => t.http().post(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
  };
}

/** Makes the staff member's last authenticator check older than the step-up window. */
export const stepUpOld = (t: TestApp, userId: string) =>
  t.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });

/** A customer row (no user) with a marker in its names. */
export async function privacyCustomer(t: TestApp, marker = 'Plain'): Promise<{ id: string; email: string }> {
  const email = uniqueEmail(`p${marker.toLowerCase()}`);
  const c = await t.prisma.customer.create({ data: { email, givenName: `${marker}Given`, familyName: `${marker}Family`, phone: '+61 400 111 222', countryOfResidence: 'NZ', source: 'panel' } });
  return { id: c.id, email };
}

/**
 * A booking for the customer with the given travel dates (YYYY-MM-DD), written straight to the tables with its first
 * snapshot, then walked by SQL to `status` (support/customer-portal walkTo).
 */
export async function bookingWithDates(
  t: TestApp, w: { pkg: { id: string }; edition: { id: string }; versionId: string }, customerId: string, status: BookingStatus, dates: { departure: string; return: string },
): Promise<string> {
  const now = new Date();
  const id = await t.prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({
      data: {
        reference: reference(), customerId, kind: 'catalogue', packageId: w.pkg.id, editionId: w.edition.id, status: 'requested', currentSnapshotVersion: 1,
        departureDate: new Date(dates.departure), returnDate: new Date(dates.return), currency: 'AUD', totalMinor: 10000n, depositMinor: 0n, balanceDueDate: new Date(dates.departure),
        residenceCountry: 'AU', requestedAt: now, requestExpiresAt: new Date(now.getTime() + 86_400_000), sourceChannel: 'panel',
        requestKeyHash: hex64(), requestConfigHash: hex64(), requestContactHmac: hex64(),
      },
      select: { id: true },
    });
    await tx.bookingSnapshot.create({
      data: { bookingId: b.id, version: 1, kind: 'original', configuration: {}, priceBreakdown: {}, totalMinor: 10000n, depositMinor: 0n, currency: 'AUD', priceVersionId: w.versionId, engineVersion: 'pricing-0.0.0' },
    });
    return b.id;
  });
  await walkTo(t, id, status);
  return id;
}

/** A calendar day in Brisbane, `offset` days from today. */
export function brisbaneDay(offset: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
