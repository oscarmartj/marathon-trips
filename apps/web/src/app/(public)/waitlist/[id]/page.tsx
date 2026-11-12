import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { WaitlistOfferView, type WaitlistEntryView } from '@/components/booking/waitlist-offer-view';
import { apiBase } from '@/lib/api-proxy';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: t('waitlist.offer.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The customer's own entry, read with their session; anything else is the same "could not show this" page. */
async function load(id: string): Promise<WaitlistEntryView | null> {
  if (!UUID.test(id ?? '')) return null;
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return null;
    const res = await fetch(`${apiBase()}/waitlist/entries/${id}`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as WaitlistEntryView) : null;
  } catch {
    return null;
  }
}

export default async function Page({ params }: Props) {
  const view = await load((await params).id);
  if (view) return <WaitlistOfferView view={view} />;
  return (
    <>
      <PageHeader title={t('waitlist.offer.notFoundTitle')} />
      <div className="container stack section">
        <p>{t('waitlist.offer.notFoundBody')}</p>
        <p>
          <Link href="/account/sign-in">{t('waitlist.offer.signIn')}</Link>
        </p>
      </div>
    </>
  );
}
