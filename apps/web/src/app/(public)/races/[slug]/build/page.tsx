import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('races.build.title') };

// The package builder never computes a price in the browser: totals come from the API.
export default function Build() {
  return <PlaceholderPage title={t('races.build.title')} intro={t('races.build.intro')} />;
}
