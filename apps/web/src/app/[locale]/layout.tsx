import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { brand, brandCssVariables } from '@mt/shared/brand';
import { Banners } from '@/components/banners';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { SkipLink } from '@/components/skip-link';
import { setRequestLocale } from '@/lib/locale-server';
import { isEnabled, openGraphLocale, enabledLocales } from '@/lib/locales';
import { siteUrl } from '@/lib/site';
import { t } from '@/lib/i18n';
import '../globals.css';

// Brand colours and fonts become CSS custom properties here, from the single brand config file.
const brandStyles = brandCssVariables();

// Header, footer and banners read the content manager. The reads are cached for a minute, so a change staff publish
// reaches every page within about a minute without a deploy. Each language is its own set of pages, built on first
// request and refreshed by the pages' own `revalidate`.
export const dynamicParams = true;
export async function generateStaticParams() {
  return enabledLocales().map((locale) => ({ locale }));
}

type Props = { children: ReactNode; params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { locale } = await params;
  const l = setRequestLocale(locale);
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: t('home.title'), template: `%s | ${brand.name}` },
    description: t('home.tagline'),
    openGraph: { type: 'website', siteName: brand.name, locale: openGraphLocale(l) },
    twitter: { card: 'summary_large_image' },
  };
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale: raw } = await params;
  // A language that is registered but not enabled is a 404, exactly like one that does not exist.
  if (!isEnabled(raw)) notFound();
  const locale = setRequestLocale(raw);
  return (
    <html lang={locale}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: brandStyles }} />
      </head>
      <body>
        <SkipLink />
        <Banners />
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
