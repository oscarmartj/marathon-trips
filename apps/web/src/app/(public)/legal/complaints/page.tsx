import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('legalPages.complaints.title') };

export default function Page() {
  return <PlaceholderPage title={t('legalPages.complaints.title')} intro={t('legalPages.intro')} legal />;
}
