import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { CmsPage } from '@/components/cms-page';
import { DEDICATED_PAGE_PATHS, getPage, localesWithContent } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';
import { localeFromParams } from '@/lib/locale-server';
import { lp, t } from '@/lib/i18n';

// Pages staff add in the content manager that have no page of their own in the code. Built on first request, then refreshed
// at most once a minute, so publishing a page needs no deploy.
export const revalidate = 60;
export const dynamicParams = true;
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ locale?: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = await localeFromParams(params);
  const { slug } = await params;
  const page = Object.hasOwn(DEDICATED_PAGE_PATHS, slug) ? null : await getPage(slug);
  // A page is only as many languages as staff have published it in: `hreflang` lists exactly those.
  return page
    ? pageMetadata({ title: page.seoTitle || page.title, description: page.seoDescription || page.intro || undefined, path: `/pages/${page.slug}`, locale, locales: await localesWithContent(async (l) => (await getPage(slug, l)) !== null) })
    : { title: t('pages.notFoundTitle'), robots: { index: false } };
}

export default async function ContentPage({ params }: Props) {
  await localeFromParams(params);
  const { slug } = await params;
  if (Object.hasOwn(DEDICATED_PAGE_PATHS, slug)) permanentRedirect(lp(DEDICATED_PAGE_PATHS[slug]!));
  const page = await getPage(slug);
  if (!page) notFound();
  return CmsPage({ slug: page.slug, page, fallback: { title: page.title, intro: page.intro } });
}
