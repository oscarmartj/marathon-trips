import type { Metadata } from 'next';
import { CmsPage, cmsPageMetadata, type PageFallback } from '@/components/cms-page';
import { localeFromParams } from '@/lib/locale-server';
import { t } from '@/lib/i18n';

// The words come from the content manager (page "contact"); the built-in wording is the fallback. Refreshed at most once a minute.
export const revalidate = 60;
const fallback = (): PageFallback => ({ title: t('contact.title'), intro: t('contact.intro') });

type Props = { params?: Promise<{ locale?: string }> };

export async function generateMetadata({ params }: Props = {}): Promise<Metadata> {
  await localeFromParams(params);
  return cmsPageMetadata('contact', fallback(), '/contact');
}

export default async function Page({ params }: Props = {}) {
  await localeFromParams(params);
  return CmsPage({ slug: 'contact', fallback: fallback() });
}
