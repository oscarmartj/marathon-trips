import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('faqPage.title') };

export default function Page() {
  return <PlaceholderPage title={t('faqPage.title')} intro={t('faqPage.intro')} />;
}
