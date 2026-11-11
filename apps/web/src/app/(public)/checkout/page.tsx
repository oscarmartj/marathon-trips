import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/placeholder-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('checkout.title') };

export default function Page() {
  return <PlaceholderPage title={t('checkout.title')} intro={t('checkout.intro')} />;
}
