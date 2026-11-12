import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

export const metadata: Metadata = pageMetadata({ title: t('legalPages.complaints.title'), description: t('legalPages.intro'), path: '/legal/complaints' });

export default function Page() {
  return <PlaceholderPage title={t('legalPages.complaints.title')} intro={t('legalPages.intro')} legal />;
}
