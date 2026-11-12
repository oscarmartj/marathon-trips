import type { Metadata } from 'next';
import { ContentImage } from './content-image';
import { PageHeader } from './page-header';
import { Prose } from './prose';
import { getPage, type PublicPage } from '@/lib/content';
import { pageMetadata } from '@/lib/seo';
import { t } from '@/lib/i18n';

export interface PageFallback {
  title: string;
  intro: string;
  /** The built-in page is a legal page: until a published one exists it carries the "pending legal review" notice. */
  legal?: boolean;
}

/** Metadata for a page the content manager can supply, with the built-in wording as the fallback. */
export async function cmsPageMetadata(slug: string, fallback: PageFallback, path: string): Promise<Metadata> {
  const page = await getPage(slug);
  return pageMetadata({
    title: page?.seoTitle || page?.title || fallback.title,
    description: page?.seoDescription || page?.intro || fallback.intro,
    path,
  });
}

/**
 * A page whose words come from the content manager. When no published page exists (nothing written yet, or the content API
 * is unreachable) it shows the built-in placeholder, so the site never has a blank or broken page. A legal page shows the
 * "pending legal review" notice while the content manager says it has not been reviewed, and always when it is the placeholder.
 */
export async function CmsPage({ slug, fallback, page: given }: { slug: string; fallback: PageFallback; page?: PublicPage | null }) {
  const page = given === undefined ? await getPage(slug) : given;
  if (!page) {
    return (
      <>
        <PageHeader title={fallback.title} intro={fallback.intro} />
        <div className="container stack">
          {fallback.legal ? <p className="notice" role="note">{t('common.legalPending')}</p> : null}
          <p>{t('common.comingSoon')}</p>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title={page.title} intro={page.intro || undefined} />
      <div className="container stack">
        {page.legalReviewPending ? <p className="notice" role="note">{t('common.legalPending')}</p> : null}
        {page.heroMedia ? <ContentImage media={page.heroMedia} /> : null}
        <Prose text={page.body} />
      </div>
    </>
  );
}
