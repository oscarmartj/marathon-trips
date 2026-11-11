import type { ReactNode } from 'react';
import { t } from '@/lib/i18n';

export const metadata = { title: t('home.title'), description: t('home.tagline') };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
