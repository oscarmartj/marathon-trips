import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { DEMO_RACE_SLUGS } from '../../../prisma/seed/demo-catalogue';
import { seed } from '../../../prisma/seed/seed';
import { TestApp, makeApp } from '../../support/auth';
import { anonymous, closeCatalogue } from '../../support/catalogue';
import { testConfig } from '../../support/platform';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const slugs = [...DEMO_RACE_SLUGS];

beforeAll(async () => {
  t = await makeApp();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await seed(prisma, 'test', testConfig());
  } finally {
    log.mockRestore();
  }
});
afterAll(async () => {
  await prisma.$disconnect();
  await closeCatalogue(t);
});

describe('demo catalogue seed (task 1.5)', () => {
  it('seed_demo_catalogue_is_complete_and_flagged_demo', async () => {
    const races = await prisma.race.findMany({
      where: { slug: { in: slugs } },
      include: { distances: true, claims: true, editions: { include: { packages: { include: { hotels: { include: { hotel: true, rooms: true } }, extras: true, entryOptions: true, participationOptions: true } }, pools: true } } },
    });
    expect(races.map((r) => r.slug).sort()).toEqual([...slugs].sort());
    for (const r of races) {
      expect(r.isDemo).toBe(true);
      expect(r.status).toBe('draft');
      expect(r.publishedAt).toBeNull();
      expect(JSON.stringify(r.name)).toContain('Demo');
      expect(r.distances.length).toBeGreaterThan(0);
      for (const e of r.editions) {
        expect(e.pools.length).toBeGreaterThan(0);
        for (const p of e.packages) {
          expect(p.saleStatus).toBe('draft');
          expect(p.publishedAt).toBeNull();
          expect(p.hotels.length).toBeGreaterThan(0);
          expect(p.extras.length).toBeGreaterThan(0);
          expect(p.entryOptions.length).toBeGreaterThan(0);
          for (const h of p.hotels) {
            expect(h.hotel.isDemo).toBe(true);
            expect(h.rooms.length).toBeGreaterThan(0);
          }
        }
      }
    }
    // One edition with a confirmed date and one without, so the web's "date to be confirmed" state has data.
    const editions = races.flatMap((r) => r.editions);
    expect(editions.some((e) => e.dateStatus === 'provisional' && e.startDate === null)).toBe(true);
    expect(editions.some((e) => e.dateStatus === 'confirmed' && e.startDate !== null)).toBe(true);
    // A pool at or under its low-stock threshold, for the panel's warning.
    const pools = editions.flatMap((e) => e.pools);
    expect(pools.some((p) => p.lowStockThreshold !== null && p.capacity - p.consumed <= p.lowStockThreshold)).toBe(true);
  });

  it('seed_demo_catalogue_claims_all_off_no_guaranteed_entry', async () => {
    const claims = await prisma.raceClaim.findMany({ where: { race: { slug: { in: slugs } } } });
    expect(claims.length).toBe(slugs.length * 3);
    expect(claims.every((c) => c.enabled === false)).toBe(true);
    const pools = await prisma.inventoryPool.findMany({ where: { edition: { race: { slug: { in: slugs } } } } });
    expect(pools.every((p) => p.confirmedBySupplier === false)).toBe(true);
  });

  it('seed_demo_catalogue_is_idempotent', async () => {
    const count = () => prisma.race.count({ where: { slug: { in: slugs } } });
    const before = [await count(), await prisma.hotel.count({ where: { isDemo: true } }), await prisma.package.count({ where: { edition: { race: { isDemo: true } } } })];
    await prisma.seedRun.delete({ where: { name: 'demo-catalogue' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await seed(prisma, 'test', testConfig());
    } finally {
      log.mockRestore();
    }
    expect([await count(), await prisma.hotel.count({ where: { isDemo: true } }), await prisma.package.count({ where: { edition: { race: { isDemo: true } } } })]).toEqual(before);
  });

  it('seed_demo_catalogue_never_in_staging_or_production', async () => {
    await expect(seed(prisma, 'production', testConfig())).rejects.toThrow(/production/);
    // Staging runs no demo step at all, so a staging database gets no demo rows from the seed.
    const { demoStaffAllowed } = await import('../../../src/platform/auth/demo-staff');
    expect(demoStaffAllowed('staging')).toBe(false);
  });

  it('seeded_demo_data_absent_from_public_api', async () => {
    const list = await anonymous(t).get('/catalogue/races?q=demo');
    expect(list.status).toBe(200);
    const listed = JSON.stringify(list.body);
    for (const s of slugs) {
      expect(listed).not.toContain(s);
      expect((await anonymous(t).get(`/catalogue/races/${s}`)).status).toBe(404);
    }
  });

  it('seeded_demo_data_cannot_be_published_by_sql', async () => {
    const race = await prisma.race.findUniqueOrThrow({ where: { slug: slugs[0] }, include: { editions: { include: { packages: true } } } });
    await expect(prisma.$executeRaw`UPDATE races SET status = 'published' WHERE id = ${race.id}::uuid`).rejects.toThrow();
    const pkg = race.editions[0]!.packages[0]!;
    await expect(prisma.$executeRaw`UPDATE packages SET "saleStatus" = 'open' WHERE id = ${pkg.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE races SET "isDemo" = false WHERE id = ${race.id}::uuid`).rejects.toThrow();
    expect((await prisma.race.findUniqueOrThrow({ where: { id: race.id } })).status).toBe('draft');
  });
});
