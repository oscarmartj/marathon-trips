import Link from 'next/link';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('common.notFoundTitle'), robots: { index: false } };

/** The 404 page keeps the landmarks of every other page (banner, main, contentinfo), so a keyboard or screen reader user can still move around. */
export default async function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <PageHeader title={t('common.notFoundTitle')} intro={t('common.notFoundIntro')} />
        <div className="container">
          <Link className="btn" href="/races">{t('common.backToRaces')}</Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
