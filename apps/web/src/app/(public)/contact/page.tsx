import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

export const metadata: Metadata = pageMetadata({ title: t('contact.title'), description: t('contact.intro'), path: '/contact' });

export default function Page() {
  return <PlaceholderPage title={t('contact.title')} intro={t('contact.intro')} />;
}
