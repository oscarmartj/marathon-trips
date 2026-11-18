import type { Tx } from './support';

/** A booking request waiting for staff, as the start page shows it (task 5.6). No customer details: those are one click away. */
export interface NewRequestForDashboard {
  id: string;
  reference: string;
  requestedAt: Date;
  requestExpiresAt: Date;
  raceName: string;
  year: number;
  packageName: string;
}

const enAu = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};

/** A plain read, no lock: how many requests are waiting, and the oldest `limit` of them (the ones to answer first). */
export async function readNewRequestsForDashboard(tx: Tx, limit: number): Promise<{ total: number; items: NewRequestForDashboard[] }> {
  const where = { status: 'requested' as const };
  const [total, rows] = await Promise.all([
    tx.booking.count({ where }),
    tx.booking.findMany({
      where, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }], take: limit,
      select: { id: true, reference: true, requestedAt: true, requestExpiresAt: true, package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } } },
    }),
  ]);
  return {
    total,
    items: rows.map((r) => ({ id: r.id, reference: r.reference, requestedAt: r.requestedAt, requestExpiresAt: r.requestExpiresAt, raceName: enAu(r.package.edition.race.name), year: r.package.edition.year, packageName: enAu(r.package.name) })),
  };
}
