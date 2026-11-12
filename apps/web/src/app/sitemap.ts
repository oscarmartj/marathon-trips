import type { MetadataRoute } from 'next';
import { listAllRaces } from '@/lib/catalogue';
import { DEDICATED_PAGE_PATHS, listPageSlugs } from '@/lib/content';
import { publicRoutes } from '@/lib/routes';
import { absoluteUrl } from '@/lib/site';

// Rendered per request so a published race appears (and an unpublished one goes) without a rebuild; the catalogue
// reads behind it are cached for a minute. If the catalogue cannot be read this throws, so crawlers get an error and
// retry instead of caching a sitemap with no races in it.
export const dynamic = 'force-dynamic';

/** Pages worth indexing: the fixed public pages that are not forms, token links or account pages. */
export const SITEMAP_STATIC_PATHS: readonly string[] = ['/', '/races', '/about', '/faq', '/contact', '/legal/terms', '/legal/privacy', '/legal/complaints'];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const known = new Set(publicRoutes.map((r) => r.path));
  const fixed = SITEMAP_STATIC_PATHS.filter((p) => known.has(p)).map((p) => ({ url: absoluteUrl(p) }));
  // Only what the public catalogue API returns: draft and demo races and draft packages never reach the web app.
  // Race pages are the only catalogue pages listed; the package builder is an interactive tool and is marked noindex.
  const races = (await listAllRaces()).map((r) => ({ url: absoluteUrl(`/races/${r.slug}`) }));
  // Pages staff publish in the content manager. A content outage leaves them out for a minute; it does not fail the sitemap.
  // Pages with a route of their own in the code (about, terms...) are already listed above.
  const pages = (await listPageSlugs()).filter((p) => !Object.hasOwn(DEDICATED_PAGE_PATHS, p.slug)).map((p) => ({ url: absoluteUrl(`/pages/${p.slug}`) }));
  return [...fixed, ...pages, ...races];
}
