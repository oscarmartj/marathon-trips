import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('about.title') };

export default function Page() {
  return <PlaceholderPage title={t('about.title')} intro={t('about.intro')} />;
}
