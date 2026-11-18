import type { Metadata } from 'next';
import { brand, brandCssVariables } from '@mt/shared/brand';
import { PageHeader } from '@/components/page-header';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { SkipLink } from '@/components/skip-link';
import { setRequestLocale } from '@/lib/locale-server';
import { DEFAULT_LOCALE } from '@/lib/locales';
import { t } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = { title: `${t('pages.notFoundTitle')} | ${brand.name}`, robots: { index: false } };

/**
 * Task 8.3: an address that matches no page at all (so no language segment decides the layout). Next.js would show its built-in
 * 404, which has no language, skip link, menu or footer; this one keeps them, in the default language.
 */
export default function GlobalNotFound() {
  const locale = setRequestLocale(DEFAULT_LOCALE);
  return (
    <html lang={locale}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: brandCssVariables() }} />
      </head>
      <body>
        <SkipLink />
        <SiteHeader />
        <main id="main">
          <PageHeader title={t('pages.notFoundTitle')} />
          <div className="container">
            <p>
              <a className="link-block" href="/">{t('nav.home')}</a>
            </p>
          </div>
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
