import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

export const metadata: Metadata = pageMetadata({ title: t('legalPages.privacy.title'), description: t('legalPages.intro'), path: '/legal/privacy' });

export default function Page() {
  return <PlaceholderPage title={t('legalPages.privacy.title')} intro={t('legalPages.intro')} legal />;
}
