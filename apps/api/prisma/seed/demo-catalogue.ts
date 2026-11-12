import { PrismaClient } from '../../src/generated/prisma/client';

type Prisma = PrismaClient;

const t = (s: string) => ({ 'en-AU': s });

/**
 * Task 1.5: fictitious catalogue, flagged `isDemo` when the rows are created. The flag cannot be set through the API
 * and cannot change afterwards, and database constraints keep a demo race out of `published` and a demo package in
 * `draft` (migration 0006), so none of this can reach the public site or the sitemap, whatever the environment.
 * Every name is invented and says "Demo"; no claim (partner, accredited, guaranteed entry) is enabled; there are no prices.
 */
export const DEMO_RACE_SLUGS = ['demo-harbour-city-marathon', 'demo-ridgeline-trail-ultra', 'demo-coastal-half-marathon'] as const;

interface DemoRace {
  slug: (typeof DEMO_RACE_SLUGS)[number];
  name: string;
  city: string;
  timeZone: string;
  raceType: 'road' | 'trail' | 'ultra';
  month: number;
  summary: string;
  distances: Array<{ kind: 'marathon' | 'half' | 'ten_k' | 'ultra'; metres: number; name: string }>;
  /** Confirmed date, or null for a provisional edition (shows as "date to be confirmed"). */
  date: string | null;
  year: number;
  hotel: { name: string; address: string; stars: number };
  rooms: Array<{ type: 'single' | 'twin' | 'double' | 'triple' | 'quad'; name: string; min: number; max: number; capacity: number }>;
  entryCapacity: number;
  /** A pool at or below its low-stock threshold, so the panel's low-stock warning has something to show. */
  lowStock?: boolean;
  checkIn: string;
  checkOut: string;
  balanceDue: string;
}

const RACES: DemoRace[] = [
  {
    slug: 'demo-harbour-city-marathon', name: 'Demo Harbour City Marathon', city: 'Sampletown', timeZone: 'Australia/Sydney', raceType: 'road', month: 5,
    summary: 'A made-up flat road marathon used to try out the panel. Not a real event.',
    distances: [{ kind: 'marathon', metres: 42195, name: 'Marathon' }, { kind: 'half', metres: 21097, name: 'Half marathon' }, { kind: 'ten_k', metres: 10000, name: '10 km' }],
    date: '2028-05-21', year: 2028, hotel: { name: 'Demo Harbourview Hotel', address: '1 Example Street', stars: 4 },
    rooms: [{ type: 'single', name: 'Single room', min: 1, max: 1, capacity: 12 }, { type: 'double', name: 'Double room', min: 1, max: 2, capacity: 20 }, { type: 'quad', name: 'Family room', min: 3, max: 4, capacity: 6 }],
    entryCapacity: 30, checkIn: '2028-05-19', checkOut: '2028-05-22', balanceDue: '2028-03-20',
  },
  {
    slug: 'demo-ridgeline-trail-ultra', name: 'Demo Ridgeline Trail Ultra', city: 'Exampleville', timeZone: 'Australia/Brisbane', raceType: 'ultra', month: 8,
    summary: 'A made-up trail ultra with a provisional date. Not a real event.',
    distances: [{ kind: 'ultra', metres: 50000, name: '50 km' }, { kind: 'half', metres: 21097, name: 'Half marathon' }],
    date: null, year: 2029, hotel: { name: 'Demo Ridge Lodge', address: '2 Sample Road', stars: 3 },
    rooms: [{ type: 'twin', name: 'Twin room', min: 1, max: 2, capacity: 8 }, { type: 'triple', name: 'Triple room', min: 2, max: 3, capacity: 4 }],
    entryCapacity: 5, lowStock: true, checkIn: '2029-08-10', checkOut: '2029-08-13', balanceDue: '2029-06-10',
  },
  {
    slug: 'demo-coastal-half-marathon', name: 'Demo Coastal Half Marathon', city: 'Placeholder Bay', timeZone: 'Australia/Perth', raceType: 'road', month: 9,
    summary: 'A made-up seaside half marathon. Not a real event.',
    distances: [{ kind: 'half', metres: 21097, name: 'Half marathon' }, { kind: 'ten_k', metres: 10000, name: '10 km' }],
    date: '2028-09-17', year: 2028, hotel: { name: 'Demo Seaside Inn', address: '3 Fictional Parade', stars: 3 },
    rooms: [{ type: 'double', name: 'Double room', min: 1, max: 2, capacity: 15 }, { type: 'twin', name: 'Twin room', min: 1, max: 2, capacity: 10 }],
    entryCapacity: 40, checkIn: '2028-09-15', checkOut: '2028-09-18', balanceDue: '2028-07-15',
  },
];

const day = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

async function seedRace(prisma: Prisma, r: DemoRace): Promise<void> {
  if (await prisma.race.findUnique({ where: { slug: r.slug } })) return;
  const race = await prisma.race.create({
    data: {
      slug: r.slug, name: t(r.name), countryCode: 'AU', city: r.city, timeZone: r.timeZone, raceType: r.raceType, typicalMonth: r.month,
      summary: t(r.summary), isDemo: true, status: 'draft',
      distances: { create: r.distances.map((d) => ({ kind: d.kind, distanceMetres: d.metres, name: t(d.name) })) },
      // Every claim exists and is off; evidence is only needed once one is switched on.
      claims: { create: (['official_partner', 'accredited_agent', 'guaranteed_entry'] as const).map((kind) => ({ kind, enabled: false })) },
    },
    include: { distances: true },
  });
  const edition = await prisma.raceEdition.create({
    data: {
      raceId: race.id, year: r.year, startDate: r.date ? day(r.date) : null, endDate: r.date ? day(r.date) : null,
      dateStatus: r.date ? 'confirmed' : 'provisional', status: 'announced',
      notes: t(r.date ? 'Demo edition with a confirmed date.' : 'Demo edition: the date is not confirmed yet.'),
    },
  });
  const entryPool = await prisma.inventoryPool.create({
    data: { editionId: edition.id, kind: 'entry', label: 'Demo race entries', capacity: r.entryCapacity, consumed: r.lowStock ? r.entryCapacity - 3 : 0, lowStockThreshold: 5, confirmedBySupplier: false },
  });
  const pkg = await prisma.package.create({
    data: {
      editionId: edition.id, slug: 'demo-race-weekend', name: t(`${r.name} weekend`), saleStatus: 'draft',
      checkInDate: day(r.checkIn), checkOutDate: day(r.checkOut), balanceDueDate: day(r.balanceDue), maxTravellers: 4,
      includes: t('Demo hotel stay and a demo race entry. Invented for testing.'), excludes: t('Flights and meals unless listed as an extra.'),
      currency: 'AUD',
      participationOptions: { create: [{ type: 'runner_with_entry' }, { type: 'supporter' }] },
      entryOptions: { create: r.distances.map((d) => ({ raceDistanceId: race.distances.find((x) => x.kind === d.kind && x.distanceMetres === d.metres)!.id, entryPoolId: entryPool.id })) },
    },
  });
  const hotel = await prisma.hotel.create({
    data: { name: r.hotel.name, address: r.hotel.address, city: r.city, countryCode: 'AU', starRating: r.hotel.stars, description: t('An invented hotel for demo data.'), isDemo: true },
  });
  const link = await prisma.packageHotel.create({ data: { packageId: pkg.id, hotelId: hotel.id } });
  for (const room of r.rooms) {
    const pool = await prisma.inventoryPool.create({ data: { editionId: edition.id, kind: 'room', label: `Demo ${room.name.toLowerCase()}`, capacity: room.capacity, lowStockThreshold: 2 } });
    await prisma.roomOption.create({ data: { packageHotelId: link.id, roomType: room.type, name: t(room.name), minOccupancy: room.min, maxOccupancy: room.max, roomPoolId: pool.id } });
  }
  const extraPool = await prisma.inventoryPool.create({ data: { editionId: edition.id, kind: 'extra', label: 'Demo pasta party seats', capacity: 40, lowStockThreshold: 5 } });
  await prisma.extra.createMany({
    data: [
      { packageId: pkg.id, kind: 'meal', name: t('Demo pasta party'), description: t('A made-up carb-loading dinner.'), pricingUnit: 'per_person', availableTo: 'all', poolId: extraPool.id },
      { packageId: pkg.id, kind: 'transfer', name: t('Demo airport transfer'), description: t('A made-up shared transfer.'), pricingUnit: 'per_booking', availableTo: 'all', maxPerBooking: 1, schedule: { origin: 'Demo airport', destination: r.hotel.name } },
    ],
  });
}

/** Creates the demo races, editions, packages, hotels, rooms and extras. Safe to run again: a race that exists is left alone. */
export async function seedDemoCatalogue(prisma: Prisma): Promise<void> {
  for (const r of RACES) await seedRace(prisma, r);
}
