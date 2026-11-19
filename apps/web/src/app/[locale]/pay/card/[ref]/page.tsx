import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { CardPage } from '@/components/pay/card-page';
import { t } from '@/lib/i18n';

type Props = { params: Promise<{ ref: string }> };

export const metadata: Metadata = { title: t('cardPage.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
// A payment page with its own nonce-based policy (task 4.4): rendered on every request, never cached.
export const dynamic = 'force-dynamic';

/** The card page of a card session (task 4.4): the gateway's hosted fields, the amount the API returns. */
export default async function Page({ params }: Props) {
  const { ref } = await params;
  return (
    <>
      <PageHeader title={t('cardPage.title')} intro={t('cardPage.intro')} />
      <div className="container stack section">
        <noscript><p className="notice">{t('cardPage.noscript')}</p></noscript>
        <CardPage sessionRef={ref} />
      </div>
    </>
  );
}
