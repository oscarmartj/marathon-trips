import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { PayLinkReturn } from '@/components/pay/pay-link-return';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('paymentReturn.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** Where the payment provider sends a payment link's holder back to (task 5.1). The address carries nothing. */
export default function Page() {
  return (
    <>
      <PageHeader title={t('paymentReturn.title')} />
      <div className="container stack section">
        <noscript><p className="notice">{t('paymentReturn.noscript')}</p></noscript>
        <PayLinkReturn />
      </div>
    </>
  );
}
