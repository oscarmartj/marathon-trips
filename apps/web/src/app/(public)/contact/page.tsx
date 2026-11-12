import type { Metadata } from 'next';
import { CmsPage, cmsPageMetadata, type PageFallback } from '@/components/cms-page';
import { t } from '@/lib/i18n';

// The words come from the content manager (page "contact"); the built-in wording is the fallback. Refreshed at most once a minute.
export const revalidate = 60;
const fallback = (): PageFallback => ({ title: t('contact.title'), intro: t('contact.intro') });

export async function generateMetadata(): Promise<Metadata> {
  return cmsPageMetadata('contact', fallback(), '/contact');
}

export default async function Page() {
  return CmsPage({ slug: 'contact', fallback: fallback() });
}
