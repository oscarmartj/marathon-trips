import type { MetadataRoute } from 'next';
import { listAllRaces } from '@/lib/catalogue';
import { DEDICATED_PAGE_PATHS, listFaqs, listPageSlugs, localesWithContent } from '@/lib/content';
import { enabledLocales, localePath, DEFAULT_LOCALE, type Locale } from '@/lib/locales';
import { publicRoutes } from '@/lib/routes';
import { absoluteUrl } from '@/lib/site';

// Rendered per request so a published race appears (and an unpublished one goes) without a rebuild; the catalogue
// reads behind it are cached for a minute. If the catalogue cannot be read this throws, so crawlers get an error and
// retry instead of caching a sitemap with no races in it.
export const dynamic = 'force-dynamic';

/** Pages worth indexing: the fixed public pages that are not forms, token links or account pages. */
export const SITEMAP_STATIC_PATHS: readonly string[] = ['/', '/races', '/about', '/faq', '/contact', '/legal/terms', '/legal/privacy', '/legal/complaints'];

type Entry = MetadataRoute.Sitemap[number];

/** One entry per language the page exists in, each carrying the full `hreflang` set (the same one the page's own metadata gives). */
export function entriesFor(path: string, locales: readonly Locale[]): Entry[] {
  if (locales.length === 0) return [];
  const languages: Record<string, string> = Object.fromEntries(locales.map((l) => [l, absoluteUrl(localePath(path, l))]));
  languages['x-default'] = absoluteUrl(localePath(path, locales.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : locales[0]!));
  return locales.map((l) => ({ url: absoluteUrl(localePath(path, l)), alternates: { languages } }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const enabled = enabledLocales();
  const known = new Set(publicRoutes.map((r) => r.path));
  // The built-in pages exist in every language; the questions page is listed only for languages that have published questions.
  const fixed = await Promise.all(
    SITEMAP_STATIC_PATHS.filter((p) => known.has(p)).map(async (p) =>
      entriesFor(p, p === '/faq' ? await localesWithContent(async (l) => (await listFaqs(l)).length > 0) : enabled),
    ),
  );
  // Only what the public catalogue API returns: draft and demo races and draft packages never reach the web app.
  // Race pages are the only catalogue pages listed; the package builder is an interactive tool and is marked noindex.
  const races = (await listAllRaces()).flatMap((r) => entriesFor(`/races/${r.slug}`, enabled));
  // Pages staff publish in the content manager, in the languages they were written in. A content outage leaves them out for
  // a minute; it does not fail the sitemap. Pages with a route of their own in the code (about, terms...) are listed above.
  const bySlug = new Map<string, Locale[]>();
  for (const l of enabled) {
    for (const p of await listPageSlugs(l)) {
      if (!Object.hasOwn(DEDICATED_PAGE_PATHS, p.slug)) bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), l]);
    }
  }
  const pages = [...bySlug.entries()].flatMap(([slug, locales]) => entriesFor(`/pages/${slug}`, locales));
  return [...fixed.flat(), ...pages, ...races];
}
