import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { ChangeForm } from '@/components/account/change-form';
import type { AccountBookingDetail } from '@/components/account/booking-overview';
import { localisedText } from '@/lib/catalogue';
import { apiBase } from '@/lib/api-proxy';
import { isBookingReference } from '@/lib/checkout';
import { changeFormProps, packageFor } from '@/lib/account-changes';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ reference: string }> };

export const metadata: Metadata = { title: t('amendments.pageTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

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

/** A customer's change of nights and extras (task 6.3). The same page as "not found" for anyone else's booking. */
export default async function Page({ params }: Props) {
  const reference = (await params).reference;
  const view = await load(reference);
  if (!view) {
    return (
      <>
        <PageHeader title={t('account.detail.notFoundTitle')} />
        <div className="container stack section"><p>{t('account.detail.notFoundBody')}</p></div>
      </>
    );
  }
  const pkg = await packageFor(view);
  const props = pkg ? changeFormProps(view, pkg) : null;
  return (
    <>
      <PageHeader title={t('amendments.pageTitle')} intro={localisedText(view.booking.package.name)} />
      <div className="container stack section">
        {props ? (
          <>
            <p>{t('amendments.pageIntro')}</p>
            <ChangeForm {...props} />
          </>
        ) : (
          <>
            <p>{t('amendments.contactUs')}</p>
            <p><Link href={`/account/bookings/${encodeURIComponent(reference)}`}>{t('amendments.back')}</Link></p>
          </>
        )}
      </div>
    </>
  );
}
