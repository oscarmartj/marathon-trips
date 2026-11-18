import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { BookingTravellersView } from '@mt/shared';
import { PageHeader } from '@/components/page-header';
import { TravellerForms } from '@/components/account/traveller-forms';
import { apiBase } from '@/lib/api-proxy';
import { isBookingReference } from '@/lib/checkout';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ reference: string }> };

export const metadata: Metadata = { title: t('account.travellers.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** The places of one of the customer's bookings, read with their session; anything else (unknown, someone else's, signed out) is null. */
async function load(reference: string): Promise<BookingTravellersView | null> {
  if (!isBookingReference(reference)) return null;
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return null;
    const res = await fetch(`${apiBase()}/account/bookings/${reference}/travellers`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as BookingTravellersView) : null;
  } catch {
    return null;
  }
}

export default async function Page({ params }: Props) {
  const { reference } = await params;
  const view = await load(reference);
  if (view) {
    return (
      <>
        <PageHeader title={t('account.travellers.title')} intro={reference} />
        <TravellerForms reference={reference} initial={view} />
        <div className="container section"><p><Link href={`/account/bookings/${encodeURIComponent(reference)}`}>{t('account.travellers.back')}</Link></p></div>
      </>
    );
  }
  // The same page for an unknown reference, someone else's booking and a signed-out visitor.
  return (
    <>
      <PageHeader title={t('account.travellers.notFoundTitle')} />
      <div className="container stack section">
        <p>{t('account.travellers.notFoundBody')}</p>
        <p><Link href="/account/sign-in">{t('account.signIn')}</Link></p>
      </div>
    </>
  );
}
