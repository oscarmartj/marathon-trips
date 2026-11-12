import type { Metadata } from 'next';
import { CmsPage, cmsPageMetadata, type PageFallback } from '@/components/cms-page';
import { t } from '@/lib/i18n';

// The words come from the content manager (page "terms"); the built-in wording is the fallback. Refreshed at most once a minute.
export const revalidate = 60;
const fallback = (): PageFallback => ({ title: t('legalPages.terms.title'), intro: t('legalPages.intro'), legal: true });

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata('terms', fallback(), '/legal/terms');
}

export default async function Page() {
  return CmsPage({ slug: 'terms', fallback: fallback() });
}
