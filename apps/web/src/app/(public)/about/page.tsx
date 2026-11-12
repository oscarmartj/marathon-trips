import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

export const metadata: Metadata = pageMetadata({ title: t('about.title'), description: t('about.intro'), path: '/about' });

export default function Page() {
  return <PlaceholderPage title={t('about.title')} intro={t('about.intro')} />;
}
