import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { PayByLink } from '@/components/pay/pay-by-link';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('payLink.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** A payment link from an email (task 5.1). The token is in the address fragment, which never reaches a server. */
export default function Page() {
  return (
    <>
      <PageHeader title={t('payLink.title')} intro={t('payLink.intro')} />
      <div className="container stack section">
        <noscript><p className="notice">{t('payLink.noscript')}</p></noscript>
        <PayByLink />
      </div>
    </>
  );
}
