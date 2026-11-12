import type { Tx } from './support';

/** What automations read about a package (task 7.4): ids for conditions, and whether it still exists. */
export interface PackageForAutomations {
  id: string;
  editionId: string;
  raceId: string;
  saleStatus: string;
  deleted: boolean;
}

/** A plain read, no lock. Null when the package does not exist. */
export async function readPackageForAutomations(tx: Tx, id: string): Promise<PackageForAutomations | null> {
  const p = await tx.package.findUnique({ where: { id }, select: { id: true, editionId: true, saleStatus: true, deletedAt: true, edition: { select: { raceId: true } } } });
  if (!p) return null;
  return { id: p.id, editionId: p.editionId, raceId: p.edition.raceId, saleStatus: p.saleStatus, deleted: !!p.deletedAt };
}

/** Which of these catalogue ids exist (packages, editions or races), for checking a rule's conditions when it is saved. */
export async function existingCatalogueIds(tx: Tx, ref: 'package' | 'edition' | 'race', ids: readonly string[]): Promise<Set<string>> {
  const where = { id: { in: [...ids] } };
  const rows = ref === 'package' ? await tx.package.findMany({ where, select: { id: true } })
    : ref === 'edition' ? await tx.raceEdition.findMany({ where, select: { id: true } })
      : await tx.race.findMany({ where, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}
