import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
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

export default async function Page({ params }: Props) {
  const view = await load((await params).reference);
  if (view) {
    return (
      <>
        <PageHeader title={t('account.detail.title')} intro={localisedText(view.booking.package.name)} />
        <BookingOverview view={view} />
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
