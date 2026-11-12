import type { Tx } from './support';
import { fromDate, toDate } from './support';

/** A held allotment with a release date, as the key dates calendar needs it (task 7.3). */
export interface HeldReleaseForCalendar {
  id: string;
  releaseDate: string;
  editionId: string;
  quantity: number;
  kind: 'room' | 'entry';
  poolLabel: string;
  supplierName: string;
}

/** A plain read, no lock: held allotments whose release date falls in [from, to] (ISO dates), optionally for one edition. */
export async function readHeldReleasesForCalendar(tx: Tx, from: string, to: string, editionId?: string): Promise<HeldReleaseForCalendar[]> {
  const rows = await tx.allotment.findMany({
    where: {
      status: 'held', releaseDate: { gte: toDate(from), lte: toDate(to) },
      contract: { deletedAt: null, supplier: { deletedAt: null } }, ...(editionId ? { pool: { editionId } } : {}),
    },
    orderBy: [{ releaseDate: 'asc' }, { id: 'asc' }],
    select: { id: true, releaseDate: true, quantity: true, kind: true, pool: { select: { label: true, editionId: true } }, contract: { select: { supplier: { select: { name: true } } } } },
  });
  return rows.map((r) => ({
    id: r.id, releaseDate: fromDate(r.releaseDate)!, editionId: r.pool.editionId, quantity: r.quantity, kind: r.kind as 'room' | 'entry',
    poolLabel: r.pool.label, supplierName: r.contract.supplier.name,
  }));
}
