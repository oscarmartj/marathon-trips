import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { publicRaceQuerySchema } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound } from '../../platform/http/api-error';
import { stockOf } from './inventory.service';
import { depositView } from './package.service';
import { PUBLIC_SALE_STATUSES } from './transitions';
import { fromDate } from './support';

type Pool = { capacity: number; consumed: number; lowStockThreshold: number | null; confirmedBySupplier: boolean };

/** What a visitor may see of a pool: three states, never the numbers (plan 5.2). */
const availability = (p: Pool) => stockOf(p).state;

/**
 * `guaranteedEntry` for one package (plan 5.2): the race has the claim switched on AND the package has at least one
 * entry stock pool AND every one of them is confirmed by the supplier. The website shows the badge only when this is true.
 */
export function guaranteedEntryOf(claimEnabled: boolean, entryPools: Array<Pick<Pool, 'confirmedBySupplier'>>): boolean {
  return claimEnabled && entryPools.length > 0 && entryPools.every((p) => p.confirmedBySupplier);
}

/** Only these rows reach the public API: published, not demo, not deleted (plan 6.1). */
const PUBLIC_RACE = { status: 'published', isDemo: false, deletedAt: null } satisfies Prisma.RaceWhereInput;
const VISIBLE_PACKAGE = { deletedAt: null, saleStatus: { in: [...PUBLIC_SALE_STATUSES] } } satisfies Prisma.PackageWhereInput;
const VISIBLE_EDITION = { status: { not: 'draft' } } satisfies Prisma.RaceEditionWhereInput;

const localised = (v: unknown): Record<string, string> => (v && typeof v === 'object' ? (v as Record<string, string>) : {});

/** Public reads. The sitemap and structured data (1.4) use these same methods, so a draft can never leak through them. */
@Injectable()
export class PublicCatalogueService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async searchRaces(q: z.infer<typeof publicRaceQuerySchema>) {
    const and: Prisma.RaceWhereInput[] = [];
    if (q.q) and.push({ OR: [{ slug: { contains: q.q, mode: 'insensitive' } }, { city: { contains: q.q, mode: 'insensitive' } }, { name: { path: ['en-AU'], string_contains: q.q, mode: 'insensitive' } }] });
    if (q.month) {
      const rows = await this.prisma.$queryRaw<Array<{ raceId: string }>>`SELECT DISTINCT "raceId" FROM race_editions WHERE status <> 'draft' AND "startDate" IS NOT NULL AND EXTRACT(MONTH FROM "startDate") = ${q.month}`;
      and.push({ OR: [{ typicalMonth: q.month }, { id: { in: rows.map((r) => r.raceId) } }] });
    }
    if (q.year) and.push({ editions: { some: { ...VISIBLE_EDITION, year: q.year } } });
    if (q.distance) and.push({ distances: { some: { kind: q.distance } } });
    const where: Prisma.RaceWhereInput = { ...PUBLIC_RACE, ...(q.country ? { countryCode: q.country } : {}), ...(q.type ? { raceType: q.type } : {}), ...(and.length ? { AND: and } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.race.count({ where }),
      this.prisma.race.findMany({
        where, orderBy: [{ slug: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { distances: { orderBy: { distanceMetres: 'desc' } }, claims: { where: { enabled: true } }, editions: { where: VISIBLE_EDITION, orderBy: { year: 'desc' } } },
      }),
    ]);
    return { items: rows.map((r) => this.raceSummary(r)), page: q.page, pageSize: q.pageSize, total };
  }

  private raceSummary(r: {
    slug: string; name: unknown; countryCode: string; city: string; raceType: string; typicalMonth: number | null; summary: unknown; websiteUrl: string | null;
    distances: Array<{ id: string; kind: string; distanceMetres: number; name: unknown }>;
    claims: Array<{ kind: string }>;
    editions: Array<{ year: number; startDate: Date | null; endDate: Date | null; dateStatus: string; status: string }>;
  }) {
    return {
      slug: r.slug, name: localised(r.name), countryCode: r.countryCode, city: r.city, raceType: r.raceType, typicalMonth: r.typicalMonth, summary: localised(r.summary), websiteUrl: r.websiteUrl,
      distances: r.distances.map((d) => ({ id: d.id, kind: d.kind, distanceMetres: d.distanceMetres, name: localised(d.name) })),
      // guaranteed_entry is never a race-level badge: it depends on confirmed stock and is reported per package.
      claims: r.claims.map((c) => c.kind).filter((k) => k !== 'guaranteed_entry'),
      editions: r.editions.map((e) => ({ year: e.year, startDate: fromDate(e.startDate), endDate: fromDate(e.endDate), dateStatus: e.dateStatus, dateConfirmed: e.dateStatus === 'confirmed', status: e.status })),
    };
  }

  async getRace(slug: string) {
    const race = await this.prisma.race.findFirst({
      where: { ...PUBLIC_RACE, slug },
      include: {
        distances: { orderBy: { distanceMetres: 'desc' } }, claims: { where: { enabled: true } },
        editions: { where: VISIBLE_EDITION, orderBy: { year: 'desc' }, include: { packages: { where: VISIBLE_PACKAGE, orderBy: { slug: 'asc' }, include: { entryOptions: { include: { entryPool: true } } } } } },
      },
    });
    if (!race) throw notFound('race_not_found', 'Race not found');
    const guaranteedClaim = race.claims.some((c) => c.kind === 'guaranteed_entry');
    return {
      ...this.raceSummary(race),
      editions: race.editions.map((e) => ({
        year: e.year, startDate: fromDate(e.startDate), endDate: fromDate(e.endDate), dateStatus: e.dateStatus, dateConfirmed: e.dateStatus === 'confirmed', status: e.status, notes: localised(e.notes),
        packages: e.packages.map((p) => ({
          id: p.id, slug: p.slug, name: localised(p.name), saleStatus: p.saleStatus, checkInDate: fromDate(p.checkInDate), checkOutDate: fromDate(p.checkOutDate), currency: p.currency,
          guaranteedEntry: guaranteedEntryOf(guaranteedClaim, p.entryOptions.map((o) => o.entryPool)),
        })),
      })),
    };
  }

  async getPackage(raceSlug: string, year: number, packageSlug: string) {
    const race = await this.prisma.race.findFirst({ where: { ...PUBLIC_RACE, slug: raceSlug }, include: { claims: { where: { enabled: true } } } });
    if (!race) throw notFound('package_not_found', 'Package not found');
    const pkg = await this.prisma.package.findFirst({
      where: { ...VISIBLE_PACKAGE, slug: packageSlug, edition: { raceId: race.id, year, ...VISIBLE_EDITION } },
      include: {
        edition: true,
        participationOptions: { where: { enabled: true }, orderBy: { type: 'asc' } },
        entryOptions: { include: { raceDistance: true, entryPool: true }, orderBy: { createdAt: 'asc' } },
        hotels: { include: { hotel: true, rooms: { include: { roomPool: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] },
        extras: { where: { deletedAt: null }, include: { pool: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!pkg) throw notFound('package_not_found', 'Package not found');
    const nights = Math.round((pkg.checkOutDate.getTime() - pkg.checkInDate.getTime()) / 86_400_000);
    const guaranteedClaim = race.claims.some((c) => c.kind === 'guaranteed_entry');
    return {
      id: pkg.id, slug: pkg.slug, name: localised(pkg.name), saleStatus: pkg.saleStatus, currency: pkg.currency,
      race: { slug: race.slug, name: localised(race.name), claims: race.claims.map((c) => c.kind).filter((k) => k !== 'guaranteed_entry') },
      edition: { year: pkg.edition.year, startDate: fromDate(pkg.edition.startDate), dateStatus: pkg.edition.dateStatus, dateConfirmed: pkg.edition.dateStatus === 'confirmed' },
      checkInDate: fromDate(pkg.checkInDate), checkOutDate: fromDate(pkg.checkOutDate), nights,
      includes: localised(pkg.includes), excludes: localised(pkg.excludes),
      instantBooking: pkg.instantBooking, deposit: depositView(pkg), balanceDueDate: fromDate(pkg.balanceDueDate),
      minTravellers: pkg.minTravellers, maxTravellers: pkg.maxTravellers, maxExtraNightsBefore: pkg.maxExtraNightsBefore, maxExtraNightsAfter: pkg.maxExtraNightsAfter,
      participation: pkg.participationOptions.map((o) => o.type),
      guaranteedEntry: guaranteedEntryOf(guaranteedClaim, pkg.entryOptions.map((o) => o.entryPool)),
      entries: pkg.entryOptions.map((o) => ({ id: o.id, distance: { id: o.raceDistance.id, kind: o.raceDistance.kind, distanceMetres: o.raceDistance.distanceMetres, name: localised(o.raceDistance.name) }, availability: availability(o.entryPool) })),
      hotels: pkg.hotels.map((h) => ({
        id: h.id, name: h.hotel.name, address: h.hotel.address, city: h.hotel.city, countryCode: h.hotel.countryCode, starRating: h.hotel.starRating, description: localised(h.hotel.description),
        rooms: h.rooms.map((r) => ({ id: r.id, roomType: r.roomType, name: localised(r.name), minOccupancy: r.minOccupancy, maxOccupancy: r.maxOccupancy, availability: availability(r.roomPool) })),
      })),
      extras: pkg.extras.map((x) => ({
        id: x.id, kind: x.kind, name: localised(x.name), description: localised(x.description), pricingUnit: x.pricingUnit, availableTo: x.availableTo, mandatory: x.mandatory, maxPerBooking: x.maxPerBooking,
        schedule: x.schedule, availability: x.pool ? availability(x.pool) : ('available' as const),
      })),
    };
  }

  /** Every URL-worthy public package, for the sitemap (1.4): the same filters as the pages themselves. */
  async listPublicPackages() {
    const rows = await this.prisma.package.findMany({
      where: { ...VISIBLE_PACKAGE, edition: { ...VISIBLE_EDITION, race: PUBLIC_RACE } },
      select: { slug: true, updatedAt: true, edition: { select: { year: true, race: { select: { slug: true } } } } },
      orderBy: [{ id: 'asc' }],
    });
    return rows.map((r) => ({ raceSlug: r.edition.race.slug, year: r.edition.year, packageSlug: r.slug, updatedAt: r.updatedAt }));
  }

  async listPublicRaceSlugs() {
    return (await this.prisma.race.findMany({ where: PUBLIC_RACE, select: { slug: true, updatedAt: true }, orderBy: { slug: 'asc' } })).map((r) => ({ slug: r.slug, updatedAt: r.updatedAt }));
  }
}
