import type { PackagePricingView } from '../catalogue';
import type { Prisma } from '../../generated/prisma/client';
import type { CatalogueView, ParticipationType, RatesView } from './engine';

type Tx = Prisma.TransactionClient;

/** The rates of one version, as the engine wants them. */
export async function loadRates(tx: Tx, priceVersionId: string, currency: string): Promise<RatesView> {
  // One after another: a transaction is one connection, and pg refuses overlapping queries on it.
  const roomRates = await tx.roomRate.findMany({ where: { priceVersionId }, orderBy: [{ roomOptionId: 'asc' }, { occupancy: 'asc' }] });
  const participationRates = await tx.participationRate.findMany({ where: { priceVersionId }, orderBy: [{ participationType: 'asc' }, { raceDistanceId: 'asc' }] });
  const extraRates = await tx.extraRate.findMany({ where: { priceVersionId }, orderBy: { extraId: 'asc' } });
  return {
    priceVersionId,
    currency,
    roomRates: roomRates.map((r) => ({ roomOptionId: r.roomOptionId, occupancy: r.occupancy, pricePerPersonMinor: r.pricePerPersonMinor, extraNightPerPersonMinor: r.extraNightPerPersonMinor, currency: r.currency })),
    participationRates: participationRates.map((r) => ({ participationType: r.participationType as ParticipationType, raceDistanceId: r.raceDistanceId, amountPerPersonMinor: r.amountPerPersonMinor, currency: r.currency })),
    extraRates: extraRates.map((r) => ({ extraId: r.extraId, amountMinor: r.amountMinor, currency: r.currency })),
  };
}

/** The published version in force at `at` for a package (validFrom ≤ at < validTo), or null. */
export async function versionInForce(tx: Tx, packageId: string, at: Date) {
  return tx.priceVersion.findFirst({
    where: { packageId, status: 'published', validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] },
    orderBy: { validFrom: 'desc' },
  });
}

/** The catalogue view without what only pricing's callers need. */
export const engineView = (v: PackagePricingView): CatalogueView => ({
  packageId: v.packageId, editionId: v.editionId, currency: v.currency, checkInDate: v.checkInDate, checkOutDate: v.checkOutDate, balanceDueDate: v.balanceDueDate,
  minTravellers: v.minTravellers, maxTravellers: v.maxTravellers, maxExtraNightsBefore: v.maxExtraNightsBefore, maxExtraNightsAfter: v.maxExtraNightsAfter,
  deposit: v.deposit, rooms: v.rooms, participationTypes: v.participationTypes, entryDistanceIds: v.entryDistanceIds, extras: v.extras,
});

/** JSON-safe copy: bigint as a string of digits (plan 0.1, 1.1). */
export function toJson<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((x) => toJson(x));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]));
  return value;
}
