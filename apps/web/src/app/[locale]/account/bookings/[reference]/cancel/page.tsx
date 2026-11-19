import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { CancellationQuoteView } from '@mt/shared';
import { PageHeader } from '@/components/page-header';
import { CancelForm } from '@/components/account/cancel-form';
import { apiBase } from '@/lib/api-proxy';
import { isBookingReference } from '@/lib/checkout';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ reference: string }> };

export const metadata: Metadata = { title: t('cancellation.page.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

async function load(reference: string): Promise<CancellationQuoteView | null> {
  if (!isBookingReference(reference)) return null;
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return null;
    const res = await fetch(`${apiBase()}/account/bookings/${reference}/cancellation-quote`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as CancellationQuoteView) : null;
  } catch {
    return null;
  }
}

/** A customer's cancellation (task 6.4): the API's quote first, then one confirmation. "Not found" for anyone else's booking. */
export default async function Page({ params }: Props) {
  const reference = (await params).reference;
  const quote = await load(reference);
  if (!quote) {
    return (
      <>
        <PageHeader title={t('account.detail.notFoundTitle')} />
        <div className="container stack section"><p>{t('account.detail.notFoundBody')}</p></div>
      </>
    );
  }
  return (
    <>
      <PageHeader title={t('cancellation.page.title')} intro={t('cancellation.page.reference', { reference })} />
      <div className="container stack section">
        <CancelForm reference={reference} initial={quote} />
      </div>
    </>
  );
}
