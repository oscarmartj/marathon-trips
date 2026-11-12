import type { Metadata } from 'next';
import { CmsPage, cmsPageMetadata, type PageFallback } from '@/components/cms-page';
import { t } from '@/lib/i18n';

// The words come from the content manager (page "complaints"); the built-in wording is the fallback. Refreshed at most once a minute.
export const revalidate = 60;
const fallback = (): PageFallback => ({ title: t('legalPages.complaints.title'), intro: t('legalPages.intro'), legal: true });

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata('complaints', fallback(), '/legal/complaints');
}

export default async function Page() {
  return CmsPage({ slug: 'complaints', fallback: fallback() });
}
