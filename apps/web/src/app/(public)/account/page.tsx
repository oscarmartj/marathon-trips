import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { AccountBookingItem } from '@mt/shared';
import { PageHeader } from '@/components/page-header';
import { AccountSummary } from '@/components/auth/account-summary';
import { AccountBookings } from '@/components/account/account-bookings';
import { apiBase } from '@/lib/api-proxy';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('account.title'), robots: { index: false, follow: false } };

/** The signed-in customer's bookings, read with their session; null when signed out or the API is not answering. */
async function load(): Promise<{ items: AccountBookingItem[] } | null> {
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return null;
    const res = await fetch(`${apiBase()}/account/bookings`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as { items: AccountBookingItem[] }) : null;
  } catch {
    return null;
  }
}

export default async function Page() {
  const view = await load();
  return (
    <>
      <PageHeader title={t('auth.customer.accountTitle')} intro={t('account.intro')} />
      <div className="container stack section">
        {view ? (
          <section className="stack" aria-labelledby="bookings-heading">
            <h2 id="bookings-heading">{t('account.list.heading')}</h2>
            <AccountBookings items={view.items} />
            <p><Link href="/races">{t('account.list.findRace')}</Link></p>
          </section>
        ) : null}
        <AccountSummary />
      </div>
    </>
  );
}
