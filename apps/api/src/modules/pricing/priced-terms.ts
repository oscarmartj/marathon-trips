import type { PackagePricingView } from '../catalogue';

/**
 * The terms of a package's extras that change the price of a configuration, stored with a version when it is published
 * (plan 2.2, sections 6 and 15, point 4): how each extra is priced, and who must take it if it is mandatory. Ids and
 * enums only.
 */
export interface PricedTerm {
  extraId: string;
  pricingUnit: 'per_person' | 'per_booking';
  mandatory: boolean;
  /** Only for mandatory extras: who an optional extra is offered to does not change any price. */
  availableTo: 'all' | 'runners' | 'supporters' | null;
}

export function pricedTermsOf(view: Pick<PackagePricingView, 'extras'>): PricedTerm[] {
  return view.extras
    .map((e) => ({ extraId: e.id, pricingUnit: e.pricingUnit, mandatory: e.mandatory, availableTo: e.mandatory ? e.availableTo : null }))
    .sort((a, b) => (a.extraId < b.extraId ? -1 : a.extraId > b.extraId ? 1 : 0));
}

const isTerm = (x: unknown): x is PricedTerm =>
  typeof x === 'object' && x !== null && typeof (x as PricedTerm).extraId === 'string' && typeof (x as PricedTerm).mandatory === 'boolean';

/**
 * Extras whose terms changed since a version was published in a way that changes a total under that version: a
 * mandatory extra removed, made optional, repriced per person ↔ per booking or offered to other travellers; an optional
 * extra repriced or made mandatory; a new mandatory extra. Removing or adding an optional extra, or changing who an
 * optional one is offered to, changes no total (its rate is the completeness check's business). Empty = no drift.
 */
export function termsDrift(stored: unknown, view: Pick<PackagePricingView, 'extras'>): string[] {
  const before = new Map((Array.isArray(stored) ? stored.filter(isTerm) : []).map((t) => [t.extraId, t]));
  const now = new Map(pricedTermsOf(view).map((t) => [t.extraId, t]));
  const drift = new Set<string>();
  for (const [id, b] of before) {
    const n = now.get(id);
    if (b.mandatory) {
      if (!n || !n.mandatory || n.pricingUnit !== b.pricingUnit || n.availableTo !== b.availableTo) drift.add(id);
    } else if (n && (n.mandatory || n.pricingUnit !== b.pricingUnit)) {
      drift.add(id);
    }
  }
  for (const [id, n] of now) if (!before.has(id) && n.mandatory) drift.add(id);
  return [...drift].sort();
}
