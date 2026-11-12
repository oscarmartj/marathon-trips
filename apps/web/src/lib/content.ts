import { apiBase } from './api-proxy';

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

export const getPage = (slug: string): Promise<PublicPage | null> => contentGet<PublicPage>(`/content/pages/${slugPath(slug)}`);
export const getGuide = (raceSlug: string): Promise<PublicGuide | null> => contentGet<PublicGuide>(`/content/guides/${slugPath(raceSlug)}`);

export async function listPageSlugs(): Promise<Array<{ slug: string; title: string }>> {
  return (await contentGet<{ items: Array<{ slug: string; title: string }> }>('/content/pages'))?.items ?? [];
}
export async function listFaqs(): Promise<PublicFaq[]> {
  return (await contentGet<{ items: PublicFaq[] }>('/content/faqs'))?.items ?? [];
}
export async function listBanners(): Promise<PublicBanner[]> {
  return (await contentGet<{ items: PublicBanner[] }>('/content/banners'))?.items ?? [];
}
export async function getMenu(): Promise<PublicMenu> {
  const m = await contentGet<Partial<PublicMenu>>('/content/menu');
  return { header: m?.header ?? [], footer_company: m?.footer_company ?? [], footer_legal: m?.footer_legal ?? [] };
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
