import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

export const metadata: Metadata = pageMetadata({ title: t('faqPage.title'), description: t('faqPage.intro'), path: '/faq' });

export default function Page() {
  return <PlaceholderPage title={t('faqPage.title')} intro={t('faqPage.intro')} />;
}
