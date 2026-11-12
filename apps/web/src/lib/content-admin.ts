import type { ContentKind } from '@mt/shared';

/**
 * The content manager's forms, as plain functions: which form values become which API body, and which row values fill a
 * form. No React here, so the rules can be tested. The API checks everything again; this only shapes what is sent.
 */
export type AdminKind = ContentKind | 'redirects';
export type Values = Record<string, string | boolean>;
export type Row = Record<string, unknown> & { id: string; version: number };

export const ADMIN_KINDS: readonly AdminKind[] = ['pages', 'guides', 'faqs', 'banners', 'menu', 'media', 'redirects'];
export const isAdminKind = (k: string): k is AdminKind => (ADMIN_KINDS as readonly string[]).includes(k);

/** Kinds whose rows are draft or published. Images and redirects are not. */
export const HAS_STATUS: Readonly<Record<AdminKind, boolean>> = { pages: true, guides: true, faqs: true, banners: true, menu: true, media: false, redirects: false };

/** Fields that can only be chosen when the item is created (a language or a race cannot move once saved). */
export const CREATE_ONLY: Readonly<Record<AdminKind, readonly string[]>> = {
  pages: ['locale', 'kind'], guides: ['raceId', 'locale'], faqs: ['locale'], banners: ['locale'], menu: ['locale'], media: [], redirects: [],
};

const s = (v: string | boolean | undefined): string => (typeof v === 'string' ? v.trim() : '');
const orNull = (v: string | boolean | undefined): string | null => s(v) || null;
/** A whole number from a text box. Anything else is passed on as typed, so the API reports it rather than the form hiding it. */
export const wholeOr = (v: string | boolean | undefined, fallback: number | null): number | null => {
  const t = s(v);
  if (t === '') return fallback;
  const n = Number(t);
  return Number.isInteger(n) ? n : (t as unknown as number);
};

/** `2027-05-01T09:30` (what a datetime-local box holds, in the browser's time zone) to an ISO instant, or null when empty. */
export function fromLocalInput(v: string | boolean | undefined): string | null {
  const t = s(v);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
}

/** An ISO instant to the value a datetime-local box takes, in the browser's time zone. */
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The request body for a create or an update. An update leaves out the fields that cannot change. */
export function contentBody(kind: AdminKind, v: Values, mode: 'create' | 'update'): Record<string, unknown> {
  const body: Record<string, unknown> = (() => {
    switch (kind) {
      case 'pages':
        return { locale: s(v.locale), slug: s(v.slug), kind: s(v.kind), title: s(v.title), intro: s(v.intro), body: s(v.body), seoTitle: s(v.seoTitle), seoDescription: s(v.seoDescription), heroMediaId: orNull(v.heroMediaId) };
      case 'guides':
        return { raceId: s(v.raceId), locale: s(v.locale), course: s(v.course), climate: s(v.climate), entry: s(v.entry), travelTips: s(v.travelTips), seoTitle: s(v.seoTitle), seoDescription: s(v.seoDescription), heroMediaId: orNull(v.heroMediaId) };
      case 'faqs':
        return { locale: s(v.locale), category: s(v.category), question: s(v.question), answer: s(v.answer), sortOrder: wholeOr(v.sortOrder, 0) };
      case 'banners':
        return { locale: s(v.locale), message: s(v.message), linkLabel: s(v.linkLabel), linkHref: s(v.linkHref), tone: s(v.tone), startsAt: fromLocalInput(v.startsAt), endsAt: fromLocalInput(v.endsAt) };
      case 'menu':
        return { locale: s(v.locale), location: s(v.location), label: s(v.label), href: s(v.href), sortOrder: wholeOr(v.sortOrder, 0) };
      case 'media':
        return { label: s(v.label), src: s(v.src), altText: v.decorative === true ? '' : s(v.altText), decorative: v.decorative === true, width: wholeOr(v.width, null), height: wholeOr(v.height, null), credit: s(v.credit) };
      case 'redirects':
        return { fromPath: s(v.fromPath), toPath: s(v.toPath), statusCode: wholeOr(v.statusCode, 301), enabled: v.enabled === true };
    }
  })();
  if (mode === 'update') for (const k of CREATE_ONLY[kind]) delete body[k];
  return body;
}

const text = (x: unknown): string => (typeof x === 'string' ? x : '');
const num = (x: unknown): string => (typeof x === 'number' ? String(x) : '');

/** Form values for a row, or for a new item when there is no row. */
export function contentInitial(kind: AdminKind, row?: Row): Values {
  const r = row ?? ({} as Partial<Row>);
  switch (kind) {
    case 'pages':
      return { locale: text(r.locale) || 'en-AU', slug: text(r.slug), kind: text(r.kind) || 'general', title: text(r.title), intro: text(r.intro), body: text(r.body), seoTitle: text(r.seoTitle), seoDescription: text(r.seoDescription), heroMediaId: text(r.heroMediaId) };
    case 'guides':
      return { raceId: text(r.raceId), locale: text(r.locale) || 'en-AU', course: text(r.course), climate: text(r.climate), entry: text(r.entry), travelTips: text(r.travelTips), seoTitle: text(r.seoTitle), seoDescription: text(r.seoDescription), heroMediaId: text(r.heroMediaId) };
    case 'faqs':
      return { locale: text(r.locale) || 'en-AU', category: text(r.category), question: text(r.question), answer: text(r.answer), sortOrder: num(r.sortOrder) || '0' };
    case 'banners':
      return { locale: text(r.locale) || 'en-AU', message: text(r.message), linkLabel: text(r.linkLabel), linkHref: text(r.linkHref), tone: text(r.tone) || 'info', startsAt: toLocalInput(r.startsAt), endsAt: toLocalInput(r.endsAt) };
    case 'menu':
      return { locale: text(r.locale) || 'en-AU', location: text(r.location) || 'header', label: text(r.label), href: text(r.href), sortOrder: num(r.sortOrder) || '0' };
    case 'media':
      return { label: text(r.label), src: text(r.src), altText: text(r.altText), decorative: r.decorative === true, width: num(r.width), height: num(r.height), credit: text(r.credit) };
    case 'redirects':
      return { fromPath: text(r.fromPath), toPath: text(r.toPath), statusCode: num(r.statusCode) || '301', enabled: row ? r.enabled === true : true };
  }
}

/** The address a published item has on the public site, or null when it has none of its own. */
export function publicPath(kind: AdminKind, row: Row): string | null {
  if (kind === 'pages') {
    const slug = text(row.slug);
    const dedicated: Record<string, string> = { about: '/about', contact: '/contact', terms: '/legal/terms', privacy: '/legal/privacy', complaints: '/legal/complaints' };
    return Object.hasOwn(dedicated, slug) ? dedicated[slug]! : `/pages/${slug}`;
  }
  if (kind === 'guides') {
    const race = row.race as { slug?: string } | undefined;
    return race?.slug ? `/races/${race.slug}` : null;
  }
  if (kind === 'faqs') return '/faq';
  return null;
}
