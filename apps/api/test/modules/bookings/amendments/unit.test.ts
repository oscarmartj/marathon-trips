// Pure parts of a change (plan docs/plans/6.3-booking-amendments.md, sections 4, 6 and 7).
import { describe, expect, it } from 'vitest';
import { changesBetween, planPlaces, relabelSlots } from '../../../../src/modules/bookings/amendment-slots';
import type { CurrentPlace } from '../../../../src/modules/bookings/amendment-slots';
import { amendedPlanItems } from '../../../../src/modules/payments/core/schedule';
import { allocate, coverageFacts } from '../../../../src/modules/payments/core/allocation';
import { price, priceDifference } from '../../../../src/modules/pricing/engine';
import type { CatalogueView, RatesView } from '../../../../src/modules/pricing/engine';
import { ApiError } from '../../../../src/platform/http/api-error';

/** A small seeded generator (no new dependency): the same cases on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('difference_is_exact_subtraction_of_engine_totals', () => {
  it('signed, exact, no rounding of its own, same currency only', () => {
    expect(priceDifference({ totalMinor: 132500n, currency: 'AUD' }, { totalMinor: 162500n, currency: 'AUD' })).toBe(30000n);
    expect(priceDifference({ totalMinor: 132500n, currency: 'AUD' }, { totalMinor: 110001n, currency: 'AUD' })).toBe(-22499n);
    expect(() => priceDifference({ totalMinor: 1n, currency: 'AUD' }, { totalMinor: 1n, currency: 'NZD' })).toThrow(/another currency/);
  });
});

describe('amended_plan_items_invariants (2 000 seeded cases)', () => {
  const kinds = ['deposit', 'balance'] as const;
  it('sum = new total, items > 0, numbered from 1, deposit first, due dates in order, deposit threshold never higher', () => {
    const r = rng(63);
    for (let n = 0; n < 2000; n++) {
      const deposit = BigInt(Math.floor(r() * 100_000));
      const balance = BigInt(Math.floor(r() * 300_000));
      const active = [
        ...(deposit > 0n ? [{ kind: kinds[0], sequence: 1, amountMinor: deposit, dueDate: '2026-11-20' }] : []),
        ...(balance > 0n ? [{ kind: kinds[1], sequence: deposit > 0n ? 2 : 1, amountMinor: balance, dueDate: '2027-04-18' }] : []),
      ];
      const oldTotal = deposit + balance;
      const newTotal = BigInt(Math.floor(r() * 500_000));
      const due = r() < 0.5 ? '2026-11-25' : '2027-05-01';
      const items = amendedPlanItems(active, newTotal, due);
      if (newTotal === oldTotal) {
        expect(items).toBeNull();
        continue;
      }
      expect(items).not.toBeNull();
      expect(items!.reduce((s, i) => s + i.amountMinor, 0n)).toBe(newTotal);
      expect(items!.every((i) => i.amountMinor > 0n)).toBe(true);
      expect(items!.map((i) => i.sequence)).toEqual(items!.map((_, i) => i + 1));
      for (let i = 1; i < items!.length; i++) expect(items![i]!.dueDate >= items![i - 1]!.dueDate).toBe(true);
      const before = coverageFacts(active, 0n).depositThresholdMinor;
      expect(coverageFacts(items!, 0n).depositThresholdMinor <= before).toBe(true);
      if (newTotal > oldTotal) expect(items!.filter((i) => i.kind === 'adjustment').map((i) => i.amountMinor)).toEqual([newTotal - oldTotal]);
      else expect(items!.some((i) => i.kind === 'adjustment')).toBe(false);
      // Allocation over the new plan never loses money: paid + overpaid = collected.
      const collected = BigInt(Math.floor(r() * 600_000));
      const a = allocate(items!, collected);
      expect(a.items.reduce((s, i) => s + i.paidMinor, 0n) + a.overpaidMinor).toBe(collected);
    }
  });

  it('an adjustment due before the balance is paid first; never before the deposit', () => {
    const active = [{ kind: 'deposit' as const, sequence: 1, amountMinor: 100000n, dueDate: '2026-11-20' }, { kind: 'balance' as const, sequence: 2, amountMinor: 32500n, dueDate: '2027-04-18' }];
    expect(amendedPlanItems(active, 162500n, '2026-11-25')!.map((i) => [i.kind, i.amountMinor, i.dueDate])).toEqual([
      ['deposit', 100000n, '2026-11-20'], ['adjustment', 30000n, '2026-11-25'], ['balance', 32500n, '2027-04-18'],
    ]);
    expect(amendedPlanItems(active, 162500n, '2026-11-01')!.map((i) => [i.kind, i.dueDate])).toEqual([['deposit', '2026-11-20'], ['adjustment', '2026-11-20'], ['balance', '2027-04-18']]);
    // A reduction is taken from the last item backwards.
    expect(amendedPlanItems(active, 82500n, '2026-11-25')!.map((i) => [i.kind, i.amountMinor])).toEqual([['deposit', 82500n]]);
  });
});

describe('places across changes', () => {
  const cur: CurrentPlace[] = [
    { slot: 1, participationType: 'runner_with_entry', raceDistanceId: 'd', isLead: true },
    { slot: 2, participationType: 'supporter', raceDistanceId: null, isLead: false },
  ];
  const room = (travellers: never[]) => [{ roomOptionId: 'r', travellers }];

  it('keeps, replaces and adds; new places after the highest number ever used; the replacing place of the lead leads', () => {
    const p = planPlaces(cur, 4, room([{ participationType: 'supporter', replacesSlot: 1 }, { keepSlot: 2 }, { participationType: 'supporter' }] as never[]), true);
    expect(p.positionToSlot).toEqual([5, 2, 6]);
    expect(p.retired).toEqual([1]);
    expect(p.added.map((a) => [a.slot, a.isLead, a.replacesSlot])).toEqual([[5, true, 1], [6, false, null]]);
  });

  it('refuses unknown or repeated places, a lost lead, a removal by a customer and more than 80 places', () => {
    const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as ApiError).code; } };
    expect(code(() => planPlaces(cur, 2, room([{ keepSlot: 3 }] as never[]), true))).toBe('place_unknown');
    expect(code(() => planPlaces(cur, 2, room([{ keepSlot: 1 }, { keepSlot: 1 }] as never[]), true))).toBe('place_listed_twice');
    expect(code(() => planPlaces(cur, 2, room([{ keepSlot: 2 }] as never[]), true))).toBe('lead_place_required');
    expect(code(() => planPlaces(cur, 2, room([{ keepSlot: 1 }] as never[]), false))).toBe('place_missing');
    expect(code(() => planPlaces(cur, 80, room([{ keepSlot: 1 }, { keepSlot: 2 }, { participationType: 'supporter' }] as never[]), true))).toBe('amendment_limit_reached');
  });

  const X = '0192f000-0000-7000-8000-000000000001';
  it('relabel_slots_changes_no_amount: seeded engine outputs keep every amount and total', () => {
    const view: CatalogueView = {
      packageId: 'p', editionId: 'e', currency: 'AUD', checkInDate: '2027-06-18', checkOutDate: '2027-06-21', balanceDueDate: '2027-04-18', minTravellers: 1, maxTravellers: 8,
      maxExtraNightsBefore: 2, maxExtraNightsAfter: 2, deposit: { mode: 'per_person', amountMinor: 50000n }, rooms: [{ id: 'q', minOccupancy: 1, maxOccupancy: 4 }],
      participationTypes: ['runner_with_entry', 'supporter'], entryDistanceIds: ['d'], extras: [{ id: X, pricingUnit: 'per_person', availableTo: 'all', mandatory: false, maxPerBooking: null }],
    };
    const rates: RatesView = {
      priceVersionId: 'v', currency: 'AUD',
      roomRates: [1, 2, 3, 4].map((o) => ({ roomOptionId: 'q', occupancy: o, pricePerPersonMinor: BigInt(100000 - o * 10000), extraNightPerPersonMinor: 15000n, currency: 'AUD' })),
      participationRates: [{ participationType: 'runner_with_entry', raceDistanceId: 'd', amountPerPersonMinor: 30000n, currency: 'AUD' }, { participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: 2500n, currency: 'AUD' }],
      extraRates: [{ extraId: X, amountMinor: 12000n, currency: 'AUD' }],
    };
    const r = rng(7);
    for (let n = 0; n < 200; n++) {
      const people = 1 + Math.floor(r() * 4);
      const travellers = Array.from({ length: people }, (_, i) => (i === 0 || r() < 0.5 ? { participationType: 'runner_with_entry' as const, raceDistanceId: 'd' } : { participationType: 'supporter' as const }));
      const b = price({ rooms: [{ roomOptionId: 'q', travellers }], extraNightsBefore: Math.floor(r() * 3), extraNightsAfter: 0, extras: [{ extraId: X, travellerSlots: [1] }] }, view, rates, [], null, new Date('2026-11-13T00:00:00Z'));
      const map = Array.from({ length: people }, (_, i) => 10 + i * 3);
      const x = relabelSlots(b, map);
      expect(x.totalMinor).toBe(b.totalMinor);
      expect(x.lines.map((l) => l.amountMinor)).toEqual(b.lines.map((l) => l.amountMinor));
      expect(x.perTraveller.map((p) => p.amountMinor)).toEqual(b.perTraveller.map((p) => p.amountMinor));
      expect(x.perTraveller.map((p) => p.slot)).toEqual(map);
      expect(x.lines.filter((l) => l.travellerSlot !== null).every((l) => l.key.endsWith(`:${l.travellerSlot}`))).toBe(true);
    }
  });

  it('changesBetween names what changed', () => {
    const base = { packageId: 'p', rooms: [{ roomOptionId: 'r', occupancy: 2, travellers: [{ slot: 1, participationType: 'runner_with_entry' as const, raceDistanceId: 'd' }, { slot: 2, participationType: 'supporter' as const, raceDistanceId: null }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [] };
    expect(changesBetween(base, { ...base, extraNightsAfter: 1 }, { retired: [], added: [] })).toEqual(['nights']);
    const replaced = { ...base, rooms: [{ ...base.rooms[0]!, travellers: [base.rooms[0]!.travellers[0]!, { slot: 3, participationType: 'runner_with_entry' as const, raceDistanceId: 'd' }] }] };
    expect(changesBetween(base, replaced, { retired: [2], added: [{ slot: 3, participationType: 'runner_with_entry', raceDistanceId: 'd', isLead: false, replacesSlot: 2 }] })).toEqual(['participation']);
    expect(changesBetween(base, base, { retired: [], added: [] })).toEqual([]);
  });
});
