import { describe, expect, it } from 'vitest';
import { PricingError, applyBps, mulDivHalfUp, price } from '../../../../src/modules/pricing/engine';
import type { EngineRequest, PriceBreakdown, PromoInput, RuleInput } from '../../../../src/modules/pricing/engine';
import { NOW, RATES, VIEW, fixed, promo, rule } from './fixture';

describe('rounding_half_up_per_line (the one rounding rule, plan 2.1 section 3)', () => {
  it.each<[bigint, number, bigint]>([
    [1n, 5000, 1n], // 0.5 → 1
    [1n, 4999, 0n], // 0.4999 → 0
    [3n, 3333, 1n], // 0.9999 → 1
    [99_999n, 1250, 12_500n], // 12 499.875 → 12 500
    [12_345n, 1000, 1_235n], // 1 234.5 → 1 235
    [125_000n, 3333, 41_663n], // 41 662.5 → 41 663
    [0n, 7777, 0n],
    [1_000_000_000_000_000n, 9999, 999_900_000_000_000n],
    [999_999_999_999_999_999n, 1, 100_000_000_000_000n], // exact for amounts far beyond 2^53
    [-5n, 5000, -3n], // symmetric: half up on the absolute value
    [-1n, 4999, 0n],
  ])('%s × %i bps → %s', (amount, bps, expected) => expect(applyBps(amount, bps, 100_000)).toBe(expected));

  it.each<[string, () => unknown]>([
    ['negative basis points', () => applyBps(100n, -1)],
    ['fractional basis points', () => applyBps(100n, 0.5)],
    ['above 100 % for a discount', () => applyBps(100n, 10_001)],
    ['odd denominator', () => mulDivHalfUp(1n, 1n, 3n)],
    ['zero denominator', () => mulDivHalfUp(1n, 1n, 0n)],
  ])('%s is refused', (_n, f) => expect(f).toThrow(PricingError));

  it('every percentage line of a breakdown is rounded once, and the total adds the rounded lines', () => {
    // 3 × 33.33 % rules on 100 001: each line rounds on its own (33 333.3333 → 33 333), never a rounded total.
    const view = { ...VIEW, extras: [] };
    const rates = { ...RATES, roomRates: [{ roomOptionId: 'single', occupancy: 1, pricePerPersonMinor: 100_001n, extraNightPerPersonMinor: 0n, currency: 'AUD' }] };
    const rules = [1, 2, 3].map((p) => rule({ priority: p, valueBps: 3333 }));
    const b = price({ rooms: [{ roomOptionId: 'single', travellers: [{ participationType: 'runner_own_entry' }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [] }, view, rates, rules, null, NOW);
    expect(b.lines.filter((l) => l.kind === 'rule').map((l) => l.amountMinor)).toEqual([33_330n, 33_330n, 33_330n]);
    expect(b.totalMinor).toBe(100_001n + 5_000n - 99_990n);
  });
});

/** A small deterministic generator (no new dependency): mulberry32 with a fixed seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('breakdown_invariants (500 seeded configurations)', () => {
  const r = rng(2_1_2027);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const types = [{ participationType: 'runner_with_entry' as const, raceDistanceId: 'marathon' }, { participationType: 'runner_with_entry' as const, raceDistanceId: 'half' }, { participationType: 'runner_own_entry' as const }, { participationType: 'supporter' as const }];
  const ranges: Record<string, [number, number]> = { single: [1, 1], double: [1, 2], triple: [3, 3], quad: [2, 4] };

  function randomRule(i: number): RuleInput {
    const percent = r() < 0.5;
    const target = pick(['accommodation', 'participation', 'extras', 'subtotal'] as const);
    const over: Partial<RuleInput> = {
      id: `r${String(i).padStart(2, '0')}`, priority: int(1, 5), stackable: r() < 0.6, appliesTo: target, direction: r() < 0.75 ? 'discount' : 'surcharge',
      conditions: r() < 0.3 ? { occupancies: [int(1, 4)] } : r() < 0.2 ? { minTravellers: int(1, 4) } : {},
      ...(percent ? { valueBps: int(0, 10_000) } : fixed(BigInt(int(0, 200_000)), { per: r() < 0.5 ? 'person' : 'booking' })),
    };
    return rule(over);
  }

  const results: PriceBreakdown[] = [];
  for (let i = 0; i < 500; i++) {
    const rooms: EngineRequest['rooms'] = Array.from({ length: int(1, 3) }, () => {
      const id = pick(Object.keys(ranges));
      const [lo, hi] = ranges[id]!;
      return { roomOptionId: id, travellers: Array.from({ length: int(lo, hi) }, () => pick(types)) };
    });
    const n = rooms.reduce((a, x) => a + x.travellers.length, 0);
    const extras: EngineRequest['extras'] = r() < 0.5 ? [{ extraId: 'tour', travellerSlots: [int(1, n)] }] : [];
    const rules = Array.from({ length: int(0, 5) }, (_, k) => randomRule(k));
    const code: PromoInput | null = r() < 0.4 ? promo({ appliesTo: pick(['accommodation', 'participation', 'extras', 'subtotal'] as const), stackable: r() < 0.5, ...(r() < 0.5 ? { valueBps: int(0, 10_000) } : (fixed(BigInt(int(0, 300_000))) as Partial<PromoInput>)) }) : null;
    const request: EngineRequest = { rooms, extraNightsBefore: int(0, 2), extraNightsAfter: int(0, 3), extras };
    try {
      const b = price(request, VIEW, RATES, rules, code, NOW);
      expect(price(request, VIEW, RATES, rules, code, NOW)).toEqual(b);
      results.push(b);
    } catch (e) {
      if (!(e instanceof PricingError) || !['travellers_out_of_range'].includes(e.code)) throw e;
    }
  }

  it('enough configurations priced', () => expect(results.length).toBeGreaterThan(400));

  it('total = charges + surcharges − discounts ≥ 0; deposit ≤ total; travellers + unattributed = total', () => {
    for (const b of results) {
      const by = (d: string) => b.lines.filter((l) => l.direction === d).reduce((a, l) => a + l.amountMinor, 0n);
      expect(b.totalMinor).toBe(by('charge') + by('surcharge') - by('discount'));
      expect(b.totalMinor).toBeGreaterThanOrEqual(0n);
      expect(b.depositMinor! <= b.totalMinor && b.depositMinor! >= 0n).toBe(true);
      expect(b.balanceMinor).toBe(b.totalMinor - b.depositMinor!);
      expect(b.perTraveller.reduce((a, p) => a + p.amountMinor, 0n) + b.unattributedMinor).toBe(b.totalMinor);
      expect(b.lines.every((l) => l.amountMinor >= 0n)).toBe(true);
    }
  });

  it('no component is discounted below zero, and discounts never exceed what they apply to', () => {
    for (const b of results) {
      for (const c of ['accommodation', 'participation', 'extras'] as const) {
        const signed = b.lines.filter((l) => l.component === c).reduce((a, l) => a + (l.direction === 'discount' ? -l.amountMinor : l.amountMinor), 0n);
        expect(signed).toBeGreaterThanOrEqual(0n);
      }
      for (const l of b.lines.filter((x) => x.direction === 'discount')) expect(l.cappedFromMinor === null || l.cappedFromMinor > l.amountMinor).toBe(true);
    }
  });
});
