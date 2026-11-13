import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { PaymentReturn } from '@/components/checkout/payment-return';
import { isBookingReference } from '@/lib/checkout';
import { t } from '@/lib/i18n';

type Props = { searchParams: Promise<{ ref?: string | string[] }> };

export const metadata: Metadata = { title: t('paymentReturn.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

/** Where the payment provider sends the customer back to. `?ref=` only names the booking; the API says what happened. */
export default async function Page({ searchParams }: Props) {
  const ref = (await searchParams).ref;
  if (!isBookingReference(ref)) {
    return (
      <>
        <PageHeader title={t('paymentReturn.invalidTitle')} />
        <div className="container stack section">
          <p>{t('paymentReturn.invalidBody')}</p>
          <p><Link href="/account/sign-in">{t('paymentReturn.signIn')}</Link></p>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title={t('paymentReturn.title')} />
      <div className="container stack section">
        <noscript><p className="notice">{t('paymentReturn.noscript')}</p></noscript>
        <PaymentReturn reference={ref} />
      </div>
    </>
  );
}
