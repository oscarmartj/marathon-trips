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

/** An edition's race name and year, for lists that mention it (task 7.3). `raceName` is the en-AU text. */
export interface EditionLabel {
  id: string;
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

/** A plain read, no lock. Editions of deleted races are left out. */
export async function readEditionLabels(tx: Tx, ids: readonly string[]): Promise<Map<string, EditionLabel>> {
  const rows = await tx.raceEdition.findMany({ where: { id: { in: [...ids] }, race: { deletedAt: null } }, select: { id: true, year: true, race: { select: { name: true } } } });
  return new Map(rows.map((r) => [r.id, { id: r.id, year: r.year, raceName: enAu(r.race.name) }]));
}

/** Editions a person can attach a key date to: newest year first, then race name. A plain read of at most 300. */
export async function listEditionLabels(tx: Tx): Promise<EditionLabel[]> {
  const rows = await tx.raceEdition.findMany({ where: { race: { deletedAt: null } }, orderBy: [{ year: 'desc' }, { id: 'desc' }], take: 300, select: { id: true, year: true, race: { select: { name: true } } } });
  return rows.map((r) => ({ id: r.id, year: r.year, raceName: enAu(r.race.name) })).sort((a, b) => b.year - a.year || a.raceName.localeCompare(b.raceName));
}
