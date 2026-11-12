import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { QuoteDetailView, type QuoteView } from '@/components/booking/quote-view';
import { apiBase } from '@/lib/api-proxy';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ reference: string }> };

export const metadata: Metadata = { title: t('quote.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** The customer's own quote, read with their session; anything else is the same "could not show this" page. */
async function load(reference: string): Promise<QuoteView | null> {
  if (!/^QT-[0-9A-HJKMNP-TV-Z]{6}$/.test(reference ?? '')) return null;
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return null;
    const res = await fetch(`${apiBase()}/quotes/${reference}`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as QuoteView) : null;
  } catch {
    return null;
  }
}

export default async function Page({ params }: Props) {
  const view = await load((await params).reference);
  if (view) return <QuoteDetailView view={view} />;
  return (
    <>
      <PageHeader title={t('quote.notFoundTitle')} />
      <div className="container stack section">
        <p>{t('quote.notFoundBody')}</p>
        <p>
          <Link href="/account/sign-in">{t('bookingRequest.signIn')}</Link>
        </p>
      </div>
    </>
  );
}
