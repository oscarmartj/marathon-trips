import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { brand, brandCssVariables } from '@mt/shared/brand';
import { SkipLink } from '@/components/skip-link';
import { siteUrl } from '@/lib/site';
import { t } from '@/lib/i18n';
import '../globals.css';

// The admin area is never indexed, and the staff panel is in the default language only.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: t('home.title'), template: `%s | ${brand.name}` },
  robots: { index: false, follow: false },
};

const brandStyles = brandCssVariables();

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <head>
        <style dangerouslySetInnerHTML={{ __html: brandStyles }} />
      </head>
      <body>
        <SkipLink />
        {children}
      </body>
    </html>
  );
}
