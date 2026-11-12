// A reference package with fixed rates, read like a rate card (phase 2, "Revisión de Oscar"). Amounts in cents (AUD).
import type { CatalogueView, EngineRequest, PromoInput, RatesView, RuleInput } from '../../../../src/modules/pricing/engine';

export const VIEW: CatalogueView = {
  packageId: 'pkg', editionId: 'edition', currency: 'AUD',
  checkInDate: '2027-06-18', checkOutDate: '2027-06-21', balanceDueDate: '2027-04-18',
  minTravellers: 1, maxTravellers: 8, maxExtraNightsBefore: 2, maxExtraNightsAfter: 3,
  deposit: { mode: 'per_person', amountMinor: 50_000n },
  rooms: [
    { id: 'single', minOccupancy: 1, maxOccupancy: 1 },
    { id: 'double', minOccupancy: 1, maxOccupancy: 2 },
    { id: 'triple', minOccupancy: 3, maxOccupancy: 3 },
    { id: 'quad', minOccupancy: 2, maxOccupancy: 4 },
  ],
  participationTypes: ['runner_with_entry', 'runner_own_entry', 'supporter'],
  entryDistanceIds: ['marathon', 'half'],
  extras: [
    { id: 'transfer', pricingUnit: 'per_booking', availableTo: 'all', mandatory: true, maxPerBooking: 2 },
    { id: 'tour', pricingUnit: 'per_person', availableTo: 'all', mandatory: false, maxPerBooking: null },
    { id: 'pasta', pricingUnit: 'per_person', availableTo: 'runners', mandatory: false, maxPerBooking: null },
    { id: 'scarf', pricingUnit: 'per_person', availableTo: 'supporters', mandatory: false, maxPerBooking: 2 },
  ],
};

const room = (roomOptionId: string, occupancy: number, pricePerPersonMinor: bigint, extraNightPerPersonMinor: bigint) => ({ roomOptionId, occupancy, pricePerPersonMinor, extraNightPerPersonMinor, currency: 'AUD' });

/** Rate card: room price per person by occupancy / extra night per person; entry or participation; extras. */
export const RATES: RatesView = {
  priceVersionId: '00000000-0000-7000-8000-000000000001',
  currency: 'AUD',
  roomRates: [
    room('single', 1, 90_000n, 30_000n),
    room('double', 1, 80_000n, 25_000n), room('double', 2, 50_000n, 15_000n),
    room('triple', 3, 40_000n, 12_000n),
    room('quad', 2, 55_000n, 16_000n), room('quad', 3, 42_000n, 12_500n), room('quad', 4, 35_000n, 10_000n),
  ],
  participationRates: [
    { participationType: 'runner_with_entry', raceDistanceId: 'marathon', amountPerPersonMinor: 30_000n, currency: 'AUD' },
    { participationType: 'runner_with_entry', raceDistanceId: 'half', amountPerPersonMinor: 20_000n, currency: 'AUD' },
    { participationType: 'runner_own_entry', raceDistanceId: null, amountPerPersonMinor: 5_000n, currency: 'AUD' },
    { participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: 2_500n, currency: 'AUD' },
  ],
  extraRates: [
    { extraId: 'transfer', amountMinor: 5_000n, currency: 'AUD' },
    { extraId: 'tour', amountMinor: 12_000n, currency: 'AUD' },
    { extraId: 'pasta', amountMinor: 4_500n, currency: 'AUD' },
    { extraId: 'scarf', amountMinor: 3_000n, currency: 'AUD' },
  ],
};

/** 10:00 on 10 January 2027 in Brisbane. */
export const NOW = new Date('2027-01-10T00:00:00.000Z');

export const M = { participationType: 'runner_with_entry' as const, raceDistanceId: 'marathon' };
export const H = { participationType: 'runner_with_entry' as const, raceDistanceId: 'half' };
export const O = { participationType: 'runner_own_entry' as const };
export const S = { participationType: 'supporter' as const };
type T = typeof M | typeof H | typeof O | typeof S;

export const req = (rooms: Array<[string, T[]]>, over: Partial<EngineRequest> = {}): EngineRequest => ({
  rooms: rooms.map(([roomOptionId, travellers]) => ({ roomOptionId, travellers })), extraNightsBefore: 0, extraNightsAfter: 0, extras: [], ...over,
});

/** Two marathon runners in a double: accommodation 100 000, participation 60 000, extras 5 000 (transfer), 165 000. */
export const DOUBLE_2M = req([['double', [M, M]]]);

let n = 0;
export const rule = (over: Partial<RuleInput>): RuleInput => ({
  id: `rule-${String(n++).padStart(3, '0')}`, scopeType: 'package', scopeId: 'pkg', kind: 'custom', direction: 'discount', conditions: {},
  effectMode: 'percent', valueBps: 1000, valueMinor: null, currency: null, per: 'booking', appliesTo: 'accommodation', priority: 10, stackable: true,
  validFrom: null, validTo: null, enabled: true, ...over,
});

export const promo = (over: Partial<PromoInput>): PromoInput => ({
  id: 'promo-1', usable: true, scopeType: 'package', scopeId: 'pkg', conditions: {}, stackable: true,
  effectMode: 'percent', valueBps: 1000, valueMinor: null, currency: null, per: 'booking', appliesTo: 'subtotal', ...over,
});

export const fixed = (valueMinor: bigint, over: Partial<RuleInput> = {}): Partial<RuleInput> => ({ effectMode: 'fixed', valueBps: null, valueMinor, currency: 'AUD', ...over });
