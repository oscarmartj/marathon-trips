import { z } from 'zod';
import { DEFAULT_LOCALE, LOCALE_PATTERN, slugSchema, versionSchema } from './catalogue';

// Request bodies and queries of the content routes (task 8.1), shared by the API and the panel.
// Strict objects: an unknown field is a 422. Content is plain text: paragraphs are separated by a blank line and nothing
// is ever rendered as HTML, so there is nothing to sanitise on the way in or out.

export const CONTENT_STATUSES = ['draft', 'published'] as const;
export const PAGE_KINDS = ['general', 'legal'] as const;
export const BANNER_TONES = ['info', 'notice', 'warning'] as const;
export const MENU_LOCATIONS = ['header', 'footer_company', 'footer_legal'] as const;
export const REDIRECT_CODES = [301, 302, 307, 308] as const;
/** The kinds of content staff manage with the same set of routes (redirects have their own, with their own permission). */
export const CONTENT_KINDS = ['pages', 'guides', 'faqs', 'banners', 'menu', 'media'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export type ContentStatusValue = (typeof CONTENT_STATUSES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const freeText = (max: number) => z.string().trim().max(max);
const reason = z.string().trim().min(1).max(500).optional();
const locale = z.string().regex(LOCALE_PATTERN);
const optional = <T extends z.ZodRawShape>(shape: T) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, (v as z.ZodType).optional()])) as unknown as { [K in keyof T]: z.ZodOptional<T[K]> };

/** The public address of a link: a path on this site (one slash, not a protocol-relative address) or an https address. */
export const linkHrefSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '/' || /^\/[^\s/\\][^\s\\]*$/.test(v) || (/^https:\/\/[^\s]+$/.test(v) && URL.canParse(v)), { message: 'Use a path on this site such as /faq, or an https address' });
const sitePath = z
  .string()
  .trim()
  .max(300)
  .refine((v) => /^\/[^\s/\\?#][^\s\\?#]*$/.test(v), { message: 'Use a path that starts with one slash, without a query or fragment' });

// ---- Media library ----

const mediaFields = {
  label: text(150),
  src: z.string().trim().max(500).refine((v) => (/^\/[A-Za-z0-9._~/-]+$/.test(v) && !v.startsWith('//')) || (/^https:\/\/[^\s]+$/.test(v) && URL.canParse(v)), { message: 'Use an https address or a path on this site' }),
  altText: freeText(300),
  decorative: z.boolean(),
  width: z.number().int().min(1).max(20000).nullable(),
  height: z.number().int().min(1).max(20000).nullable(),
  credit: freeText(300),
};
const altRule = (v: { altText?: string; decorative?: boolean }) => v.decorative === undefined || v.altText === undefined || (v.decorative ? v.altText === '' : v.altText.length > 0);
const ALT_MESSAGE = { message: 'Describe the image, or mark it decorative and leave the description empty' };
export const createMediaSchema = z
  .strictObject({ ...mediaFields, altText: mediaFields.altText.default(''), decorative: mediaFields.decorative.default(false), width: mediaFields.width.default(null), height: mediaFields.height.default(null), credit: mediaFields.credit.default(''), reason })
  .refine(altRule, ALT_MESSAGE)
  .refine((v) => v.decorative || v.altText.length > 0, ALT_MESSAGE);
export const updateMediaSchema = z.strictObject({ ...optional(mediaFields), version: versionSchema, reason }).refine(altRule, ALT_MESSAGE);

// ---- Pages ----

const pageFields = {
  locale,
  slug: slugSchema,
  kind: z.enum(PAGE_KINDS),
  title: text(200),
  intro: freeText(500),
  body: freeText(50_000),
  seoTitle: freeText(120),
  seoDescription: freeText(300),
  heroMediaId: z.uuid().nullable(),
};
export const createPageSchema = z.strictObject({
  ...pageFields,
  locale: pageFields.locale.default(DEFAULT_LOCALE),
  kind: pageFields.kind.default('general'),
  intro: pageFields.intro.default(''),
  body: pageFields.body.default(''),
  seoTitle: pageFields.seoTitle.default(''),
  seoDescription: pageFields.seoDescription.default(''),
  heroMediaId: pageFields.heroMediaId.default(null),
  reason,
});
/** `locale` and `kind` are fixed once a page exists: changing them would move a published address. */
export const updatePageSchema = z.strictObject({ ...optional({ slug: pageFields.slug, title: pageFields.title, intro: pageFields.intro, body: pageFields.body, seoTitle: pageFields.seoTitle, seoDescription: pageFields.seoDescription, heroMediaId: pageFields.heroMediaId }), version: versionSchema, reason });
export const legalReviewSchema = z.strictObject({ pending: z.boolean(), version: versionSchema, reason });

// ---- Race guides ----

const guideFields = {
  raceId: z.uuid(),
  locale,
  course: freeText(20_000),
  climate: freeText(20_000),
  entry: freeText(20_000),
  travelTips: freeText(20_000),
  seoTitle: freeText(120),
  seoDescription: freeText(300),
  heroMediaId: z.uuid().nullable(),
};
export const createGuideSchema = z.strictObject({
  ...guideFields,
  locale: guideFields.locale.default(DEFAULT_LOCALE),
  course: guideFields.course.default(''),
  climate: guideFields.climate.default(''),
  entry: guideFields.entry.default(''),
  travelTips: guideFields.travelTips.default(''),
  seoTitle: guideFields.seoTitle.default(''),
  seoDescription: guideFields.seoDescription.default(''),
  heroMediaId: guideFields.heroMediaId.default(null),
  reason,
});
export const updateGuideSchema = z.strictObject({ ...optional({ course: guideFields.course, climate: guideFields.climate, entry: guideFields.entry, travelTips: guideFields.travelTips, seoTitle: guideFields.seoTitle, seoDescription: guideFields.seoDescription, heroMediaId: guideFields.heroMediaId }), version: versionSchema, reason });

// ---- FAQs ----

const faqFields = { locale, category: freeText(80), question: text(300), answer: text(10_000), sortOrder: z.number().int().min(0).max(100_000) };
export const createFaqSchema = z.strictObject({ ...faqFields, locale: faqFields.locale.default(DEFAULT_LOCALE), category: faqFields.category.default(''), sortOrder: faqFields.sortOrder.default(0), reason });
export const updateFaqSchema = z.strictObject({ ...optional({ category: faqFields.category, question: faqFields.question, answer: faqFields.answer, sortOrder: faqFields.sortOrder }), version: versionSchema, reason });

// ---- Banners ----

const isoInstant = z.iso.datetime({ offset: true });
const bannerFields = { locale, message: text(300), linkLabel: freeText(60), linkHref: z.union([linkHrefSchema, z.literal('')]), tone: z.enum(BANNER_TONES), startsAt: isoInstant.nullable(), endsAt: isoInstant.nullable() };
const linkPair = (v: { linkLabel?: string; linkHref?: string }) => v.linkLabel === undefined || v.linkHref === undefined || (v.linkLabel === '') === (v.linkHref === '');
const LINK_MESSAGE = { message: 'A link needs both its words and its address' };
const window_ = (v: { startsAt?: string | null; endsAt?: string | null }) => !v.startsAt || !v.endsAt || Date.parse(v.startsAt) < Date.parse(v.endsAt);
const WINDOW_MESSAGE = { message: 'The banner must start before it ends' };
export const createBannerSchema = z
  .strictObject({ ...bannerFields, locale: bannerFields.locale.default(DEFAULT_LOCALE), linkLabel: bannerFields.linkLabel.default(''), linkHref: bannerFields.linkHref.default(''), tone: bannerFields.tone.default('info'), startsAt: bannerFields.startsAt.default(null), endsAt: bannerFields.endsAt.default(null), reason })
  .refine(linkPair, LINK_MESSAGE)
  .refine(window_, WINDOW_MESSAGE);
export const updateBannerSchema = z.strictObject({ ...optional({ message: bannerFields.message, linkLabel: bannerFields.linkLabel, linkHref: bannerFields.linkHref, tone: bannerFields.tone, startsAt: bannerFields.startsAt, endsAt: bannerFields.endsAt }), version: versionSchema, reason }).refine(linkPair, LINK_MESSAGE).refine(window_, WINDOW_MESSAGE);

// ---- Menu ----

const menuFields = { locale, location: z.enum(MENU_LOCATIONS), label: text(60), href: linkHrefSchema, sortOrder: z.number().int().min(0).max(100_000) };
export const createMenuItemSchema = z.strictObject({ ...menuFields, locale: menuFields.locale.default(DEFAULT_LOCALE), sortOrder: menuFields.sortOrder.default(0), reason });
export const updateMenuItemSchema = z.strictObject({ ...optional({ location: menuFields.location, label: menuFields.label, href: menuFields.href, sortOrder: menuFields.sortOrder }), version: versionSchema, reason });

// ---- Status (publish and unpublish) ----

export const contentStatusSchema = z.strictObject({ status: z.enum(CONTENT_STATUSES), version: versionSchema, reason });

// ---- Redirects ----

const redirectFields = { fromPath: sitePath, toPath: linkHrefSchema, statusCode: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]), enabled: z.boolean() };
export const createRedirectSchema = z.strictObject({ ...redirectFields, statusCode: redirectFields.statusCode.default(301), enabled: redirectFields.enabled.default(true), reason });
export const updateRedirectSchema = z.strictObject({ ...optional(redirectFields), version: versionSchema, reason });

// ---- Queries ----

export const contentListQuerySchema = z.strictObject({
  status: z.enum(CONTENT_STATUSES).optional(),
  locale: locale.optional(),
  raceId: z.uuid().optional(),
  location: z.enum(MENU_LOCATIONS).optional(),
  kind: z.enum(PAGE_KINDS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
});
/** The public routes: only a language, which defaults to en-AU. */
export const publicContentQuerySchema = z.strictObject({ locale: locale.default(DEFAULT_LOCALE) });
