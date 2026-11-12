import type { ZodType } from 'zod';
import {
  createBannerSchema, createFaqSchema, createGuideSchema, createMediaSchema, createMenuItemSchema, createPageSchema,
  updateBannerSchema, updateFaqSchema, updateGuideSchema, updateMediaSchema, updateMenuItemSchema, updatePageSchema,
} from '@mt/shared';
import type { ContentKind } from '@mt/shared';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { type Tx, paragraphs } from './support';

/** The few Prisma delegate methods the generic service uses. Every content model has them. */
export interface Delegate {
  findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<Record<string, unknown>>;
  updateMany(args: unknown): Promise<{ count: number }>;
  delete(args: unknown): Promise<unknown>;
}

export interface KindSpec {
  /** Prisma model accessor on the transaction client. */
  model: 'mediaAsset' | 'contentPage' | 'contentGuide' | 'contentFaq' | 'contentBanner' | 'contentMenuItem';
  /** AuditLog.entityType. */
  entityType: string;
  /** Middle part of the audit action, such as page in content.page.created. */
  noun: string;
  create: ZodType;
  update: ZodType;
  /** Rows have a draft/published status. */
  hasStatus: boolean;
  /** Rows carry publishedAt, set when the status becomes published. */
  hasPublishedAt: boolean;
  include?: Record<string, unknown>;
  orderBy: unknown[];
  /** Filters from the list query that apply to this kind. */
  filters: ReadonlyArray<'status' | 'locale' | 'raceId' | 'location' | 'kind'>;
  uniqueConflict?: { code: string; message: string };
  /** Checks references and fills derived columns before a create. */
  prepareCreate?(tx: Tx, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Checks the merged result of an update. */
  prepareUpdate?(tx: Tx, before: Record<string, unknown>, data: Record<string, unknown>): Promise<void>;
  /** Throws when the row must not go public as it is. */
  publishGuard?(row: Record<string, unknown>): void;
  /** Throws when the row must not be deleted. */
  deleteGuard?(tx: Tx, row: Record<string, unknown>): Promise<void>;
}

async function mediaExists(tx: Tx, id: unknown): Promise<void> {
  if (id === null || id === undefined) return;
  if (!(await tx.mediaAsset.findUnique({ where: { id: id as string }, select: { id: true } }))) throw notFound('media_not_found', 'Image not found');
}

const filled = (row: Record<string, unknown>, keys: string[]): boolean => keys.some((k) => typeof row[k] === 'string' && paragraphs(row[k] as string).length > 0);

const bannerCheck = (m: { linkLabel: string; linkHref: string; startsAt: Date | string | null; endsAt: Date | string | null }): void => {
  if ((m.linkLabel === '') !== (m.linkHref === '')) throw unprocessable('banner_link_incomplete', 'A link needs both its words and its address');
  if (m.startsAt && m.endsAt && new Date(m.startsAt).getTime() >= new Date(m.endsAt).getTime()) throw unprocessable('banner_window_invalid', 'The banner must start before it ends');
};

export const KINDS: Record<ContentKind, KindSpec> = {
  pages: {
    model: 'contentPage', entityType: 'ContentPage', noun: 'page', create: createPageSchema, update: updatePageSchema, hasStatus: true, hasPublishedAt: true,
    include: { heroMedia: true }, orderBy: [{ locale: 'asc' }, { slug: 'asc' }], filters: ['status', 'locale', 'kind'],
    uniqueConflict: { code: 'page_slug_taken', message: 'A page with this address already exists in this language' },
    // A new legal page starts as pending legal review. Only the legal review route (its own permission) clears that.
    prepareCreate: async (tx, d) => { await mediaExists(tx, d.heroMediaId); return { ...d, legalReviewPending: d.kind === 'legal' }; },
    prepareUpdate: async (tx, _b, d) => { await mediaExists(tx, d.heroMediaId); },
    publishGuard: (row) => { if (!filled(row, ['body'])) throw conflict('page_empty', 'Write the page before publishing it'); },
  },
  guides: {
    model: 'contentGuide', entityType: 'ContentGuide', noun: 'guide', create: createGuideSchema, update: updateGuideSchema, hasStatus: true, hasPublishedAt: true,
    include: { heroMedia: true, race: { select: { id: true, slug: true, name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], filters: ['status', 'locale', 'raceId'],
    uniqueConflict: { code: 'guide_exists', message: 'This race already has a guide in this language' },
    prepareCreate: async (tx, d) => {
      if (!(await tx.race.findFirst({ where: { id: d.raceId as string, deletedAt: null }, select: { id: true } }))) throw notFound('race_not_found', 'Race not found');
      await mediaExists(tx, d.heroMediaId);
      return d;
    },
    prepareUpdate: async (tx, _b, d) => { await mediaExists(tx, d.heroMediaId); },
    publishGuard: (row) => { if (!filled(row, ['course', 'climate', 'entry', 'travelTips'])) throw conflict('guide_empty', 'Write at least one section before publishing the guide'); },
  },
  faqs: {
    model: 'contentFaq', entityType: 'ContentFaq', noun: 'faq', create: createFaqSchema, update: updateFaqSchema, hasStatus: true, hasPublishedAt: false,
    orderBy: [{ locale: 'asc' }, { category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }], filters: ['status', 'locale'],
  },
  banners: {
    model: 'contentBanner', entityType: 'ContentBanner', noun: 'banner', create: createBannerSchema, update: updateBannerSchema, hasStatus: true, hasPublishedAt: false,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], filters: ['status', 'locale'],
    prepareCreate: async (_tx, d) => { bannerCheck(d as never); return d; },
    prepareUpdate: async (_tx, b, d) => { bannerCheck({ ...(b as never as Parameters<typeof bannerCheck>[0]), ...(d as object) }); },
  },
  menu: {
    model: 'contentMenuItem', entityType: 'ContentMenuItem', noun: 'menu_item', create: createMenuItemSchema, update: updateMenuItemSchema, hasStatus: true, hasPublishedAt: false,
    orderBy: [{ locale: 'asc' }, { location: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }], filters: ['status', 'locale', 'location'],
  },
  media: {
    model: 'mediaAsset', entityType: 'MediaAsset', noun: 'media', create: createMediaSchema, update: updateMediaSchema, hasStatus: false, hasPublishedAt: false,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], filters: [],
    prepareUpdate: async (_tx, b, d) => {
      const m = { decorative: b.decorative as boolean, altText: b.altText as string, ...(d as object) } as { decorative: boolean; altText: string };
      if (m.decorative ? m.altText !== '' : m.altText.trim() === '') throw unprocessable('media_alt_text', 'Describe the image, or mark it decorative and leave the description empty');
    },
    deleteGuard: async (tx, row) => {
      const id = row.id as string;
      const inUse = (await tx.contentPage.count({ where: { heroMediaId: id } })) + (await tx.contentGuide.count({ where: { heroMediaId: id } }));
      if (inUse > 0) throw conflict('media_in_use', 'This image is used by a page or a guide. Change those first.');
    },
  },
};

export const isContentKind = (k: string): k is ContentKind => Object.hasOwn(KINDS, k);
