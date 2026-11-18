import { apiBase } from './api-proxy';
import { currentLocale } from './i18n';
import { enabledLocales, type Locale } from './locales';

/**
 * What the public content API returns (apps/api/src/modules/content/public.service.ts). The web app only displays it.
 * Content is plain text: it is shown as text and never as HTML. Every read here is tolerant: if the API is down or has
 * nothing, the caller gets null or an empty list and falls back to the built-in wording, so a content outage never takes
 * a page down. The reads are cached for a minute, which is how a published change reaches the site without a deploy.
 */
export interface MediaRef { src: string; altText: string; decorative: boolean; width: number | null; height: number | null }
export interface PublicPage {
  slug: string; locale: string; kind: 'general' | 'legal'; title: string; intro: string; body: string; seoTitle: string; seoDescription: string;
  legalReviewPending: boolean; publishedAt: string | null; updatedAt: string; heroMedia: MediaRef | null;
}
export interface PublicGuide {
  raceSlug: string; locale: string; course: string; climate: string; entry: string; travelTips: string; seoTitle: string; seoDescription: string;
  publishedAt: string | null; updatedAt: string; heroMedia: MediaRef | null;
}
export interface PublicFaq { id: string; category: string; question: string; answer: string; sortOrder: number }
export type BannerTone = 'info' | 'notice' | 'warning';
export interface PublicBanner { id: string; message: string; linkLabel: string; linkHref: string; tone: BannerTone }
export interface MenuItem { label: string; href: string }
export interface PublicMenu { header: MenuItem[]; footer_company: MenuItem[]; footer_legal: MenuItem[] }

export const CONTENT_REVALIDATE_SECONDS = 60;

/** The JSON at `path`, or null when it is missing or the API cannot be reached. */
export async function contentGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { accept: 'application/json' }, next: { revalidate: CONTENT_REVALIDATE_SECONDS } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const slugPath = (s: string) => encodeURIComponent(s);
const withLocale = (path: string, locale: Locale) => `${path}${path.includes('?') ? '&' : '?'}locale=${encodeURIComponent(locale)}`;

/**
 * Every read below takes the language of the request unless one is given. There is no fallback to another language
 * (8.1): a language with nothing published gets null or an empty list, and the page shows its built-in wording, which is
 * translated like the rest of the interface. Language is part of the cache key because it is part of the URL.
 */
export const getPage = (slug: string, locale: Locale = currentLocale()): Promise<PublicPage | null> => contentGet<PublicPage>(withLocale(`/content/pages/${slugPath(slug)}`, locale));
export const getGuide = (raceSlug: string, locale: Locale = currentLocale()): Promise<PublicGuide | null> => contentGet<PublicGuide>(withLocale(`/content/guides/${slugPath(raceSlug)}`, locale));

export async function listPageSlugs(locale: Locale = currentLocale()): Promise<Array<{ slug: string; title: string }>> {
  return (await contentGet<{ items: Array<{ slug: string; title: string }> }>(withLocale('/content/pages', locale)))?.items ?? [];
}
export async function listFaqs(locale: Locale = currentLocale()): Promise<PublicFaq[]> {
  return (await contentGet<{ items: PublicFaq[] }>(withLocale('/content/faqs', locale)))?.items ?? [];
}
export async function listBanners(locale: Locale = currentLocale()): Promise<PublicBanner[]> {
  return (await contentGet<{ items: PublicBanner[] }>(withLocale('/content/banners', locale)))?.items ?? [];
}
export async function getMenu(locale: Locale = currentLocale()): Promise<PublicMenu> {
  const m = await contentGet<Partial<PublicMenu>>(withLocale('/content/menu', locale));
  return { header: m?.header ?? [], footer_company: m?.footer_company ?? [], footer_legal: m?.footer_legal ?? [] };
}

/** The enabled languages for which `has` says content exists: what a page's `hreflang` set is built from. */
export async function localesWithContent(has: (locale: Locale) => Promise<boolean>): Promise<Locale[]> {
  const enabled = enabledLocales();
  const flags = await Promise.all(enabled.map((l) => has(l).catch(() => false)));
  return enabled.filter((_, i) => flags[i]);
}

/** Paragraphs of a plain-text field: split at blank lines, trimmed, empty ones dropped. */
export function paragraphs(text: string): string[] {
  return text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
}

/** FAQs grouped by category, in the order the API sends them (category, then position). Uncategorised questions come first. */
export function groupFaqs(faqs: readonly PublicFaq[]): Array<{ category: string; items: PublicFaq[] }> {
  const groups = new Map<string, PublicFaq[]>();
  for (const f of faqs) groups.set(f.category, [...(groups.get(f.category) ?? []), f]);
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}

/** A link from the content manager: a path on this site, or an https address that opens as an outside link. */
export const isExternalHref = (href: string): boolean => /^https:\/\//.test(href);

/** Pages that have their own route in the code. `/pages/<slug>` for one of these redirects there, so a page has one address. */
export const DEDICATED_PAGE_PATHS: Readonly<Record<string, string>> = {
  about: '/about',
  contact: '/contact',
  terms: '/legal/terms',
  privacy: '/legal/privacy',
  complaints: '/legal/complaints',
};
