import type { Metadata } from 'next';
import { CmsPage, cmsPageMetadata, type PageFallback } from '@/components/cms-page';
import { localeFromParams } from '@/lib/locale-server';
import { t } from '@/lib/i18n';

// The words come from the content manager (page "about"); the built-in wording is the fallback. Refreshed at most once a minute.
export const revalidate = 60;
const fallback = (): PageFallback => ({ title: t('about.title'), intro: t('about.intro') });

type Props = { params?: Promise<{ locale?: string }> };

export async function generateMetadata({ params }: Props = {}): Promise<Metadata> {
  await localeFromParams(params);
  return cmsPageMetadata('about', fallback(), '/about');
}

export default async function Page({ params }: Props = {}) {
  await localeFromParams(params);
  return CmsPage({ slug: 'about', fallback: fallback() });
}
