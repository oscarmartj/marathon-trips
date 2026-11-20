import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { SecureFieldsPage } from '@/components/pay/secure-fields-page';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ ref: string }> };

export const metadata: Metadata = { title: t('cardPage.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
// A payment page with its own nonce-based policy (task 9.1, as the card page of 4.4): rendered on every request, never cached.
export const dynamic = 'force-dynamic';

/** eWAY's card page (task 9.1): its Secure Fields, then the bank's check, then the one charge; the amount the API returns. */
export default async function Page({ params }: Props) {
  const { ref } = await params;
  return (
    <>
      <PageHeader title={t('cardPage.title')} intro={t('cardPage.intro')} />
      <div className="container stack section">
        <noscript><p className="notice">{t('cardPage.noscript')}</p></noscript>
        <SecureFieldsPage sessionRef={ref} />
      </div>
    </>
  );
}
