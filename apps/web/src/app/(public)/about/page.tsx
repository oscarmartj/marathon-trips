import type { Metadata } from 'next';
import { CmsPage, cmsPageMetadata, type PageFallback } from '@/components/cms-page';
import { t } from '@/lib/i18n';

// The words come from the content manager (page "about"); the built-in wording is the fallback. Refreshed at most once a minute.
export const revalidate = 60;
const fallback = (): PageFallback => ({ title: t('about.title'), intro: t('about.intro') });

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata('about', fallback(), '/about');
}

export default async function Page() {
  return CmsPage({ slug: 'about', fallback: fallback() });
}
