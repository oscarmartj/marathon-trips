import Link from 'next/link';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('common.notFoundTitle'), robots: { index: false } };

/** Inside the public layout (header, main, footer are already there): only the content of the 404 page. */
export default function PublicNotFound() {
  return (
    <>
      <PageHeader title={t('common.notFoundTitle')} intro={t('common.notFoundIntro')} />
      <div className="container">
        <Link className="btn" href="/races">{t('common.backToRaces')}</Link>
      </div>
    </>
  );
}
