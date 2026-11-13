import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { CheckoutTermsView, PaymentPlanView } from '@mt/shared';
import { PageHeader } from '@/components/page-header';
import { CheckoutForm } from '@/components/checkout/checkout-form';
import { apiBase } from '@/lib/api-proxy';
import { isBookingReference, notPayableKey } from '@/lib/checkout';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ reference: string }> };

export const metadata: Metadata = { title: t('checkout.bookingTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };

type Loaded = { kind: 'ok'; plan: PaymentPlanView; terms: CheckoutTermsView } | { kind: 'signedOut' } | { kind: 'notPayable'; reason: string | undefined } | { kind: 'termsUnavailable' };

/** The customer's own plan and the current terms, read with their session. Anything that is not theirs is "signed out". */
async function load(reference: string): Promise<Loaded> {
  if (!isBookingReference(reference)) return { kind: 'signedOut' };
  try {
    const cookie = (await cookies()).toString();
    if (!cookie) return { kind: 'signedOut' };
    const get = (path: string) => fetch(`${apiBase()}/booking-requests/${reference}/${path}`, { headers: { cookie, accept: 'application/json' }, cache: 'no-store' });
    const planRes = await get('payment-plan');
    if (!planRes.ok) return { kind: 'signedOut' };
    const plan = (await planRes.json()) as PaymentPlanView;
    if (!plan.payable) return { kind: 'notPayable', reason: plan.notPayableReason };
    const termsRes = await get('checkout-terms');
    if (termsRes.status === 409) return { kind: 'termsUnavailable' };
    if (!termsRes.ok) return { kind: 'signedOut' };
    return { kind: 'ok', plan, terms: (await termsRes.json()) as CheckoutTermsView };
  } catch {
    return { kind: 'signedOut' };
  }
}

export default async function Page({ params }: Props) {
  const { reference } = await params;
  const loaded = await load(reference);
  if (loaded.kind === 'ok') {
    return (
      <>
        <PageHeader title={t('checkout.bookingTitle')} intro={t('checkout.intro')} />
        <div className="container section">
          <CheckoutForm plan={loaded.plan} initialTerms={loaded.terms} />
        </div>
      </>
    );
  }
  const booking = `/trips/requests/${encodeURIComponent(reference)}`;
  return (
    <>
      <PageHeader title={loaded.kind === 'signedOut' ? t('checkout.signedOutTitle') : t('checkout.bookingTitle')} />
      <div className="container stack section">
        {loaded.kind === 'signedOut' ? (
          <>
            <p>{t('checkout.signedOutBody')}</p>
            <p><Link href="/account/sign-in">{t('checkout.signIn')}</Link></p>
          </>
        ) : (
          <>
            <p className="notice" role="status">{loaded.kind === 'termsUnavailable' ? t('checkout.termsUnavailable') : t(`checkout.notPayable.${notPayableKey(loaded.reason)}`)}</p>
            <p><Link href={booking}>{t('checkout.viewBooking')}</Link></p>
          </>
        )}
      </div>
    </>
  );
}
