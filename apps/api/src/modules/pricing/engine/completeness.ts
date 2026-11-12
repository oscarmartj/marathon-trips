import type { CatalogueView, ParticipationType, RatesView } from './types';

export type MissingRate =
  | { kind: 'room'; roomOptionId: string; occupancy: number }
  | { kind: 'participation'; participationType: ParticipationType; raceDistanceId: string | null }
  | { kind: 'extra'; extraId: string };

/**
 * What a version lacks to price every configuration the package offers (plan 2.1, G1): each room at each occupancy
 * in its range, each enabled kind of traveller (runners with an entry: each offered distance) and each extra that is
 * not deleted, mandatory or not. A package on sale must never meet a missing rate.
 */
export function missingRates(view: CatalogueView, rates: RatesView): MissingRate[] {
  const missing: MissingRate[] = [];
  for (const room of view.rooms) {
    for (let occupancy = room.minOccupancy; occupancy <= room.maxOccupancy; occupancy++) {
      if (!rates.roomRates.some((r) => r.roomOptionId === room.id && r.occupancy === occupancy)) missing.push({ kind: 'room', roomOptionId: room.id, occupancy });
    }
  }
  for (const type of [...view.participationTypes].sort()) {
    const distances: Array<string | null> = type === 'runner_with_entry' ? [...view.entryDistanceIds].sort() : [null];
    for (const d of distances) {
      if (!rates.participationRates.some((r) => r.participationType === type && r.raceDistanceId === d)) missing.push({ kind: 'participation', participationType: type, raceDistanceId: d });
    }
  }
  for (const extra of view.extras) {
    if (!rates.extraRates.some((r) => r.extraId === extra.id)) missing.push({ kind: 'extra', extraId: extra.id });
  }
  return missing;
}
