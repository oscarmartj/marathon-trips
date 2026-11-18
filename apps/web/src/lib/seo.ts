import type { Metadata } from 'next';
import { brand } from '@mt/shared/brand';
import { absoluteUrl } from './site';
import { localisedText, type RaceDetail } from './catalogue';
import { countryName } from './catalogue-format';
import { currentLocale, t } from './i18n';
import { DEFAULT_LOCALE, enabledLocales, localePath, openGraphLocale, type Locale } from './locales';

/** The language of the page being rendered (the request's language; the default outside a request). */
export const pageLocale = (): Locale => currentLocale();

/**
 * Canonical address and `hreflang` links for a page: one alternate per language the page exists in (every enabled language
 * unless `locales` narrows it, as it does for content that is only written in some languages), each pointing at that
 * language's own address, plus `x-default` for the default language. With one language enabled this is the page itself
 * and `x-default`. A language that is not enabled is never listed.
 */
export function pageAlternates(path: string, locale: Locale = pageLocale(), locales?: readonly Locale[]): NonNullable<Metadata['alternates']> {
  const enabled = enabledLocales();
  const present = (locales ?? enabled).filter((l) => enabled.includes(l));
  const set = present.includes(locale) ? present : [locale, ...present];
  const languages: Record<string, string> = {};
  for (const l of set) languages[l] = absoluteUrl(localePath(path, l));
  languages['x-default'] = absoluteUrl(localePath(path, set.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : set[0]!));
  return { canonical: absoluteUrl(localePath(path, locale)), languages };
}

/** Title, description, canonical, `hreflang`, Open Graph and Twitter card for a page. The share image comes from the segment's `opengraph-image`. */
export function pageMetadata(input: { title: string; description?: string; path: string; locale?: Locale; locales?: readonly Locale[] }): Metadata {
  const { title, description, path } = input;
  const locale = input.locale ?? pageLocale();
  return {
    title,
    ...(description ? { description } : {}),
    alternates: pageAlternates(path, locale, input.locales),
    openGraph: { type: 'website', siteName: brand.name, locale: openGraphLocale(locale), url: absoluteUrl(localePath(path, locale)), title, ...(description ? { description } : {}) },
    twitter: { card: 'summary_large_image', title, ...(description ? { description } : {}) },
  };
}

export type JsonLd = Record<string, unknown>;

/** A breadcrumb trail. The last item is the current page. */
export function breadcrumbJsonLd(items: ReadonlyArray<{ name: string; path: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: absoluteUrl(item.path) })),
  };
}

/** A `FAQPage` for the published questions, in the order the page shows them. Answers are plain text. */
export function faqJsonLd(faqs: ReadonlyArray<{ question: string; answer: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })),
  };
}

const EVENT_STATUS: Record<string, string> = {
  cancelled: 'https://schema.org/EventCancelled',
  postponed: 'https://schema.org/EventPostponed',
};

/**
 * One `SportsEvent` per edition that has a confirmed start date. An edition whose date is not confirmed gets no
 * structured data at all, so a search engine never shows a provisional date as fact. No `Offer` is emitted: the public
 * catalogue carries no prices yet (they come from the pricing engine), and an offer without a price is not valid.
 * No organiser, partner or accreditation is stated.
 */
export function raceEventsJsonLd(race: Pick<RaceDetail, 'slug' | 'name' | 'summary' | 'city' | 'countryCode' | 'editions'>): JsonLd[] {
  const name = localisedText(race.name);
  const description = localisedText(race.summary);
  return race.editions.flatMap((e) => (e.dateConfirmed && e.startDate ? [{ ...e, startDate: e.startDate }] : [])).map((e) => ({
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: `${name} ${e.year}`,
    ...(description ? { description } : {}),
    startDate: e.startDate.slice(0, 10),
    ...(e.endDate ? { endDate: e.endDate.slice(0, 10) } : {}),
    eventStatus: EVENT_STATUS[e.status] ?? 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url: absoluteUrl(localePath(`/races/${race.slug}`, pageLocale())),
    location: {
      '@type': 'Place',
      name: race.city,
      address: { '@type': 'PostalAddress', addressLocality: race.city, addressCountry: race.countryCode },
    },
  }));
}

/** The text of the share image and the page description fall back to this when a race has no summary of its own. */
export const raceDescription = (race: Pick<RaceDetail, 'summary' | 'city' | 'countryCode' | 'name'>): string =>
  localisedText(race.summary) || t('seo.raceDescription', { name: localisedText(race.name), city: race.city, country: countryName(race.countryCode) });

/** JSON for a `<script type="application/ld+json">`: `<` is escaped so catalogue text can never close the tag. */
export const serialiseJsonLd = (data: JsonLd | JsonLd[]): string => JSON.stringify(data).replace(/</g, '\\u003c');
