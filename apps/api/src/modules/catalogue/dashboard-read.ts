import type { Tx } from './support';

/** A place pool as the staff start page shows it (task 5.6). `raceName` is the en-AU text. */
export interface StockForDashboard {
  id: string;
  kind: 'entry' | 'room' | 'extra';
  label: string;
  capacity: number;
  remaining: number;
  lowStock: boolean;
  editionId: string;
  year: number;
  raceName: string;
}

const enAu = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const pick = o['en-AU'] ?? o.en ?? Object.values(o).find((x) => typeof x === 'string');
    if (typeof pick === 'string') return pick;
  }
  return '';
};

/**
 * A plain read, no lock: the pools of live editions (race not deleted, edition not completed or cancelled, capacity above
 * zero) with the fewest places left first, at most `limit`. `lowCount` is how many of all of them are low or sold out.
 */
export async function readStockForDashboard(tx: Tx, limit: number): Promise<{ items: StockForDashboard[]; lowCount: number }> {
  const [low] = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM inventory_pools p
    JOIN race_editions e ON e.id = p."editionId" JOIN races r ON r.id = e."raceId"
    WHERE r."deletedAt" IS NULL AND e.status NOT IN ('completed', 'cancelled') AND p.capacity > 0
      AND (p.consumed >= p.capacity OR (p."lowStockThreshold" IS NOT NULL AND p.capacity - p.consumed <= p."lowStockThreshold"))`;
  const ids = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT p.id::text AS id FROM inventory_pools p
    JOIN race_editions e ON e.id = p."editionId" JOIN races r ON r.id = e."raceId"
    WHERE r."deletedAt" IS NULL AND e.status NOT IN ('completed', 'cancelled') AND p.capacity > 0
    ORDER BY (p.capacity - p.consumed), p.id LIMIT ${limit}`;
  const pools = await tx.inventoryPool.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    select: { id: true, kind: true, label: true, capacity: true, consumed: true, lowStockThreshold: true, edition: { select: { id: true, year: true, race: { select: { name: true } } } } },
  });
  const byId = new Map(pools.map((p) => [p.id, p]));
  const items = ids.flatMap(({ id }) => {
    const p = byId.get(id);
    if (!p) return [];
    const remaining = p.capacity - p.consumed;
    return [{
      id: p.id, kind: p.kind as StockForDashboard['kind'], label: p.label, capacity: p.capacity, remaining,
      lowStock: p.consumed >= p.capacity || (p.lowStockThreshold !== null && remaining <= p.lowStockThreshold),
      editionId: p.edition.id, year: p.edition.year, raceName: enAu(p.edition.race.name),
    }];
  });
  return { items, lowCount: low?.n ?? 0 };
}
