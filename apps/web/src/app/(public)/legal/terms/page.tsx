import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

export const metadata: Metadata = pageMetadata({ title: t('legalPages.terms.title'), description: t('legalPages.intro'), path: '/legal/terms' });

export default function Page() {
  return <PlaceholderPage title={t('legalPages.terms.title')} intro={t('legalPages.intro')} legal />;
}
