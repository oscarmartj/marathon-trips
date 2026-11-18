import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { RequestConfirmation, type RequestView } from '@/components/booking/request-confirmation';
import { apiBase } from '@/lib/api-proxy';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ reference: string }> };

export const metadata: Metadata = { title: t('bookingRequest.confirmation.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** The customer's own request, read with their session; anything else is a 404. */
async function load(reference: string): Promise<RequestView | null> {
  if (!/^MT-[0-9A-HJKMNP-TV-Z]{6}$/.test(reference ?? '')) return null;
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return null;
    const res = await fetch(`${apiBase()}/booking-requests/${reference}`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as RequestView) : null;
  } catch {
    return null;
  }
}

export default async function Page({ params }: Props) {
  const view = await load((await params).reference);
  if (view) return <RequestConfirmation view={view} />;
  // Unknown, someone else's, or signed out: the same page, which says nothing about whether the reference exists.
  return (
    <>
      <PageHeader title={t('bookingRequest.confirmation.notFoundTitle')} />
      <div className="container stack section">
        <p>{t('bookingRequest.confirmation.notFoundBody')}</p>
        <p>
          <Link href="/account/sign-in">{t('bookingRequest.signIn')}</Link>
        </p>
      </div>
    </>
  );
}
