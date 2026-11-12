import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { adminPackageQuerySchema } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { CustomFieldsService } from '../../platform/common/custom-fields/custom-fields.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound } from '../../platform/http/api-error';
import { stockOf } from './inventory.service';
import { PACKAGE_VIEW_INCLUDE, PublicCatalogueService, packageView } from './public.service';
import { view } from './support';

const enAU = (v: unknown): string => (v && typeof v === 'object' && typeof (v as Record<string, unknown>)['en-AU'] === 'string' ? ((v as Record<string, string>)['en-AU'] as string) : '');

/** Read models for the panel: the package list, the preview and the low-stock warning (task 1.2). */
@Injectable()
export class CataloguePanelService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
    @Inject(PublicCatalogueService) private readonly publicCatalogue: PublicCatalogueService,
  ) {}

  async listPackages(q: z.infer<typeof adminPackageQuerySchema>) {
    const cf = await this.customFields.filterWhere('Package', q.cf);
    const where: Prisma.PackageWhereInput = {
      deletedAt: null,
      ...(cf.length ? { AND: cf as Prisma.PackageWhereInput[] } : {}),
      edition: { race: { deletedAt: null } },
      ...(q.saleStatus ? { saleStatus: q.saleStatus } : {}),
      ...(q.editionId ? { editionId: q.editionId } : {}),
      ...(q.q ? { OR: [{ slug: { contains: q.q, mode: 'insensitive' } }, { name: { path: ['en-AU'], string_contains: q.q, mode: 'insensitive' } }, { edition: { race: { slug: { contains: q.q, mode: 'insensitive' } } } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.package.count({ where }),
      this.prisma.package.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { edition: { select: { id: true, year: true, race: { select: { id: true, slug: true, name: true } } } } },
      }),
    ]);
    const items = rows.map((p) => ({
      id: p.id, slug: p.slug, name: p.name, saleStatus: p.saleStatus, checkInDate: p.checkInDate, checkOutDate: p.checkOutDate, version: p.version,
      edition: { id: p.edition.id, year: p.edition.year }, race: { id: p.edition.race.id, slug: p.edition.race.slug, name: p.edition.race.name },
    }));
    return view({ items, page: q.page, pageSize: q.pageSize, total });
  }

  /**
   * The package exactly as the public site will show it, whatever its status. It is built by the same code as the public
   * route, so it carries no stock numbers and only claims a guaranteed entry when the rule holds.
   */
  async preview(id: string) {
    const pkg = await this.prisma.package.findFirst({ where: { id, deletedAt: null, edition: { race: { deletedAt: null } } }, include: PACKAGE_VIEW_INCLUDE });
    if (!pkg) throw notFound('package_not_found', 'Package not found');
    const race = await this.prisma.race.findUniqueOrThrow({ where: { id: pkg.edition.raceId }, include: { claims: true } });
    return view({ ...packageView(race, pkg, await this.publicCatalogue.packageCustomFields(pkg)), preview: true as const, raceStatus: race.status, editionStatus: pkg.edition.status, isDemo: race.isDemo });
  }

  /** Pools of live editions that are running low or have run out (capacity above zero). Panel only: it shows numbers. */
  async lowStock() {
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p.id FROM inventory_pools p
      JOIN race_editions e ON e.id = p."editionId"
      JOIN races r ON r.id = e."raceId"
      WHERE r."deletedAt" IS NULL AND e.status NOT IN ('completed', 'cancelled') AND p.capacity > 0
        AND (p.consumed >= p.capacity OR (p."lowStockThreshold" IS NOT NULL AND p.capacity - p.consumed <= p."lowStockThreshold"))
      ORDER BY p.id LIMIT 200`;
    const pools = await this.prisma.inventoryPool.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      include: { edition: { select: { id: true, year: true, race: { select: { id: true, slug: true, name: true } } } } },
    });
    const items = pools
      .map((p) => ({ ...stockOf(p), id: p.id, kind: p.kind, label: p.label, capacity: p.capacity, edition: { id: p.edition.id, year: p.edition.year }, race: { id: p.edition.race.id, slug: p.edition.race.slug, name: enAU(p.edition.race.name) } }))
      .sort((a, b) => a.remaining - b.remaining || a.id.localeCompare(b.id));
    return view({ items, total: items.length });
  }
}
