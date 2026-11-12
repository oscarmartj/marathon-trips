import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound } from '../../platform/http/api-error';
import { view } from './support';

/** Only these races have a public guide: published, not demo, not deleted (same rule as the public catalogue). */
const PUBLIC_RACE = { status: 'published', isDemo: false, deletedAt: null } as const;

const media = { select: { src: true, altText: true, decorative: true, width: true, height: true } } as const;

/** What the public site reads: published content only, plain text, no ids of staff and no drafts. */
@Injectable()
export class PublicContentService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async page(slug: string, locale: string) {
    const p = await this.prisma.contentPage.findFirst({ where: { slug, locale, status: 'published' }, include: { heroMedia: media } });
    if (!p) throw notFound('not_found', 'Not found');
    return view({
      slug: p.slug, locale: p.locale, kind: p.kind, title: p.title, intro: p.intro, body: p.body, seoTitle: p.seoTitle, seoDescription: p.seoDescription,
      legalReviewPending: p.kind === 'legal' && p.legalReviewPending, publishedAt: p.publishedAt, updatedAt: p.updatedAt, heroMedia: p.heroMedia,
    });
  }

  /** Published general pages, for the sitemap and the `/pages/[slug]` route. */
  async pages(locale: string) {
    const rows = await this.prisma.contentPage.findMany({ where: { locale, status: 'published', kind: 'general' }, select: { slug: true, title: true, updatedAt: true }, orderBy: { slug: 'asc' }, take: 500 });
    return view({ items: rows });
  }

  async guide(raceSlug: string, locale: string) {
    const g = await this.prisma.contentGuide.findFirst({
      where: { locale, status: 'published', race: { slug: raceSlug, ...PUBLIC_RACE } },
      include: { heroMedia: media },
    });
    if (!g) throw notFound('not_found', 'Not found');
    return view({
      raceSlug, locale: g.locale, course: g.course, climate: g.climate, entry: g.entry, travelTips: g.travelTips, seoTitle: g.seoTitle, seoDescription: g.seoDescription,
      publishedAt: g.publishedAt, updatedAt: g.updatedAt, heroMedia: g.heroMedia,
    });
  }

  async faqs(locale: string) {
    const rows = await this.prisma.contentFaq.findMany({
      where: { locale, status: 'published' }, select: { id: true, category: true, question: true, answer: true, sortOrder: true },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }], take: 500,
    });
    return view({ items: rows });
  }

  /** Banners that are published and inside their window right now. */
  async banners(locale: string, now = new Date()) {
    const rows = await this.prisma.contentBanner.findMany({
      where: { locale, status: 'published', AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
      select: { id: true, message: true, linkLabel: true, linkHref: true, tone: true },
      orderBy: [{ createdAt: 'desc' }], take: 5,
    });
    return view({ items: rows });
  }

  async menu(locale: string) {
    const rows = await this.prisma.contentMenuItem.findMany({
      where: { locale, status: 'published' }, select: { location: true, label: true, href: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 200,
    });
    const out: Record<'header' | 'footer_company' | 'footer_legal', Array<{ label: string; href: string }>> = { header: [], footer_company: [], footer_legal: [] };
    for (const r of rows) out[r.location].push({ label: r.label, href: r.href });
    return out;
  }

  async redirects() {
    const rows = await this.prisma.contentRedirect.findMany({ where: { enabled: true }, select: { fromPath: true, toPath: true, statusCode: true }, orderBy: { fromPath: 'asc' }, take: 1000 });
    return { items: rows };
  }
}
