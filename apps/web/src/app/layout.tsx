import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { brand, brandCssVariables } from '@mt/shared/brand';
import { SkipLink } from '@/components/skip-link';
import { t } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: { default: t('home.title'), template: `%s | ${brand.name}` },
  description: t('home.tagline'),
};

// Brand colours and fonts become CSS custom properties here, from the single brand config file.
const brandStyles = brandCssVariables();

export default function RootLayout({ children }: { children: ReactNode }) {
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
