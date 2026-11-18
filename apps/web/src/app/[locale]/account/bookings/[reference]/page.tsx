import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import type { BookingTravellersView } from '@mt/shared';
import { BookingOverview, type AccountBookingDetail } from '@/components/account/booking-overview';
import { localisedText } from '@/lib/catalogue';
import { apiBase } from '@/lib/api-proxy';
import { isBookingReference } from '@/lib/checkout';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ reference: string }> };

export const metadata: Metadata = { title: t('account.detail.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** One of the customer's bookings, read with their session; anything else (unknown, someone else's, signed out) is null. */
async function load(reference: string): Promise<AccountBookingDetail | null> {
  if (!isBookingReference(reference)) return null;
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return null;
    const res = await fetch(`${apiBase()}/account/bookings/${reference}`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as AccountBookingDetail) : null;
  } catch {
    return null;
  }
}

/** The places and their details; null when they cannot be read, and the booking page simply leaves the section out. */
async function loadTravellers(reference: string): Promise<BookingTravellersView | null> {
  try {
    const cookie = (await cookies()).toString();
    const res = await fetch(`${apiBase()}/account/bookings/${reference}/travellers`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as BookingTravellersView) : null;
  } catch {
    return null;
  }
}

export default async function Page({ params }: Props) {
  const reference = (await params).reference;
  const view = await load(reference);
  if (view) {
    const travellers = await loadTravellers(reference);
    return (
      <>
        <PageHeader title={t('account.detail.title')} intro={localisedText(view.booking.package.name)} />
        <BookingOverview view={view} travellers={travellers} />
      </>
    );
  }
  // The same page for an unknown reference, someone else's booking and a signed-out visitor.
  return (
    <>
      <PageHeader title={t('account.detail.notFoundTitle')} />
      <div className="container stack section">
        <p>{t('account.detail.notFoundBody')}</p>
        <p><Link href="/account/sign-in">{t('account.signIn')}</Link></p>
      </div>
    </>
  );
}
