import { PROMO_CODE_PATTERN, normalisePromoCode, ruleConditionsSchema } from '@mt/shared';
import type { RuleConditionsInput } from '@mt/shared';
import type { Prisma, PriceRule, PromoCode } from '../../generated/prisma/client';
import { notFound, unprocessable } from '../../platform/http/api-error';
import type { PackagePricingReader } from '../catalogue';
import { PricingError, validateConditions, validateEffect } from './engine';
import type { ConfigOrigin, PromoInput, RuleConditions, RuleInput } from './engine';

// Rules and promo codes as stored, turned into what the pure engine takes (plan 2.2, sections 3, 4 and 7), and the
// checks that run when one is saved. The engine's own validation runs at save, so a stored rule is never invalid.

type Tx = Prisma.TransactionClient;

/** At most this many rules that are not archived per scope (one package, one edition, or global) (plan 2.2, section 3). */
export const MAX_RULES_PER_SCOPE = 50;
/** A quote loads its three scopes: at most this many. One more means the limit was bypassed: the quote fails (point 8). */
export const MAX_RULES_PER_QUOTE = 3 * MAX_RULES_PER_SCOPE;

/** Stored conditions, checked against the schema; anything else is a configuration error of the rule or code. */
function conditionsOf(raw: unknown, id: string, origin: ConfigOrigin): RuleConditions {
  const parsed = ruleConditionsSchema.safeParse(raw);
  if (!parsed.success) throw new PricingError('rule_invalid', 'Stored conditions do not match their schema', { id, origin });
  return parsed.data;
}

const scopeIdOf = (row: { packageId: string | null; editionId: string | null }) => row.packageId ?? row.editionId ?? null;

export function ruleInputOf(row: PriceRule): RuleInput {
  return {
    id: row.id, scopeType: row.scopeType, scopeId: scopeIdOf(row), kind: row.kind, direction: row.direction,
    conditions: conditionsOf(row.conditions, row.id, 'rule'), effectMode: row.effectMode, valueBps: row.valueBps, valueMinor: row.valueMinor,
    currency: row.currency, per: row.per, appliesTo: row.appliesTo, priority: row.priority, stackable: row.stackable,
    validFrom: row.validFrom, validTo: row.validTo, enabled: row.enabled,
  };
}

/** Usable at `now`: enabled, not archived, within its validity and not exhausted (plan 2.2, section 4). */
export function promoUsableAt(row: Pick<PromoCode, 'enabled' | 'archivedAt' | 'validFrom' | 'validTo' | 'maxRedemptions' | 'redeemedCount'>, now: Date): boolean {
  if (!row.enabled || row.archivedAt !== null) return false;
  if (row.validFrom && now.getTime() < row.validFrom.getTime()) return false;
  if (row.validTo && now.getTime() >= row.validTo.getTime()) return false;
  return row.maxRedemptions === null || row.redeemedCount < row.maxRedemptions;
}

/**
 * The same answer for a code that does not exist, is disabled, expired, exhausted or archived (plan 2.1, section 1,
 * point 8): the engine reports it as `invalid`.
 */
export const UNKNOWN_CODE: PromoInput = {
  id: 'unknown', usable: false, scopeType: 'global', scopeId: null, conditions: {}, stackable: false,
  effectMode: 'percent', valueBps: 0, valueMinor: null, currency: null, per: 'booking', appliesTo: 'subtotal',
};

export function promoInputOf(row: PromoCode, now: Date): PromoInput {
  const usable = promoUsableAt(row, now);
  return {
    id: row.id, usable, scopeType: row.scopeType, scopeId: scopeIdOf(row),
    // An unusable code is never applied: its conditions are not even read, so it cannot fail.
    conditions: usable ? conditionsOf(row.conditions, row.id, 'promo') : {},
    stackable: row.stackable, effectMode: row.effectMode, valueBps: row.valueBps, valueMinor: row.valueMinor,
    currency: row.currency, per: row.per, appliesTo: row.appliesTo,
  };
}

/** The rules a quote of this package considers: global, its edition's and its own, not archived, in engine order. */
export async function rulesForPackage(tx: Tx, packageId: string, editionId: string): Promise<RuleInput[]> {
  const rows = await tx.priceRule.findMany({
    where: { archivedAt: null, OR: [{ scopeType: 'global' }, { packageId }, { editionId }] },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    take: MAX_RULES_PER_QUOTE + 1,
  });
  if (rows.length > MAX_RULES_PER_QUOTE) throw new PricingError('rule_cap_exceeded', 'Too many rules apply to this package', { origin: 'rule' });
  return rows.map(ruleInputOf);
}

/** The code typed by the customer, as stored, or null when it cannot be a code (wrong format). */
export function normalisedOrNull(typed: string): string | null {
  const code = normalisePromoCode(typed);
  return PROMO_CODE_PATTERN.test(code) ? code : null;
}

/** The stored code for what was typed, archived codes excluded; null when there is none. */
export async function findPromo(tx: Tx, typed: string): Promise<PromoCode | null> {
  const code = normalisedOrNull(typed);
  if (code === null) return null;
  const row = await tx.promoCode.findUnique({ where: { code } });
  return row && row.archivedAt === null ? row : null;
}

// ---- Checks when a rule or code is saved ----

export interface EffectInput {
  kind: string;
  direction: 'discount' | 'surcharge';
  conditions: RuleConditionsInput;
  effectMode: 'percent' | 'fixed';
  valueBps: number | null;
  valueMinor: string | null;
  currency: string | null;
  per: 'person' | 'booking';
  appliesTo: 'accommodation' | 'participation' | 'extras' | 'subtotal';
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Runs the engine's own validation on what is about to be saved (plan 2.2, section 3): an invalid rule or code is a
 * 422 here and never reaches a quote. Fixed amounts per person are capped so that, times the most travellers a quote
 * can hold, no line can exceed the line limit (point 10).
 */
export function assertValidAdjustment(input: EffectInput, origin: ConfigOrigin): void {
  const c = input.conditions;
  if (c.minDaysBeforeCheckIn !== undefined && c.maxDaysBeforeCheckIn !== undefined && c.minDaysBeforeCheckIn > c.maxDaysBeforeCheckIn) {
    throw unprocessable('rule_invalid', 'The minimum number of days is above the maximum');
  }
  if (c.minTravellers !== undefined && c.maxTravellers !== undefined && c.minTravellers > c.maxTravellers) {
    throw unprocessable('rule_invalid', 'The minimum number of travellers is above the maximum');
  }
  if (input.validFrom && input.validTo && new Date(input.validTo).getTime() <= new Date(input.validFrom).getTime()) {
    throw unprocessable('validity_invalid', 'The end must be after the start');
  }
  try {
    validateEffect({ ...input, valueMinor: input.valueMinor === null ? null : BigInt(input.valueMinor) }, 'new', origin);
    validateConditions(c, input.kind, 'new', origin);
  } catch (e) {
    if (e instanceof PricingError) throw unprocessable(e.code, e.message);
    throw e;
  }
}

/**
 * The scope exists and a fixed amount is in its currency: the package's, or every package's of the edition (plan 2.2,
 * section 3). A trigger checks the same in the database.
 */
export async function assertScope(tx: Tx, catalogue: PackagePricingReader, s: { scopeType: string; editionId: string | null; packageId: string | null; currency: string | null }): Promise<void> {
  const shape =
    (s.scopeType === 'global' && s.editionId === null && s.packageId === null)
    || (s.scopeType === 'edition' && s.editionId !== null && s.packageId === null)
    || (s.scopeType === 'package' && s.packageId !== null && s.editionId === null);
  if (!shape) throw unprocessable('scope_invalid', 'A global rule names nothing, an edition rule its edition, a package rule its package');
  if (s.scopeType === 'package') {
    const view = await catalogue.load(tx, s.packageId!);
    if (!view) throw notFound('package_not_found', 'Package not found');
    if (s.currency !== null && s.currency !== view.currency) throw unprocessable('currency_mismatch', 'A fixed amount must be in the currency of its package');
  }
  if (s.scopeType === 'edition') {
    const currencies = await catalogue.editionCurrencies(tx, s.editionId!);
    if (currencies === null) throw notFound('edition_not_found', 'Edition not found');
    if (s.currency !== null && currencies.some((c) => c !== s.currency)) throw unprocessable('currency_mismatch', 'A fixed amount must be in the currency of every package of its edition');
  }
}

/** A field left out of an update keeps its value; `null` is a value (it clears a nullable field). */
export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * A stored rule or code in the shape of the input, so a partial update merges with it and the merged result is validated
 * as a whole (plan 2.2, code review G1): a PATCH that leaves a field out never resets it.
 */
export const storedEffectInput = (row: Pick<PriceRule, 'conditions' | 'effectMode' | 'valueBps' | 'valueMinor' | 'currency' | 'per' | 'appliesTo' | 'validFrom' | 'validTo'>) => ({
  conditions: row.conditions as RuleConditionsInput,
  effectMode: row.effectMode,
  valueBps: row.valueBps,
  valueMinor: row.valueMinor === null ? null : row.valueMinor.toString(),
  currency: row.currency as 'AUD' | null,
  per: row.per,
  appliesTo: row.appliesTo,
  validFrom: row.validFrom === null ? null : row.validFrom.toISOString(),
  validTo: row.validTo === null ? null : row.validTo.toISOString(),
});

/** What is stored for the effect, from the validated input. */
export const effectData = (i: EffectInput) => ({
  conditions: i.conditions as Prisma.InputJsonValue,
  effectMode: i.effectMode,
  valueBps: i.valueBps,
  valueMinor: i.valueMinor === null ? null : BigInt(i.valueMinor),
  currency: i.currency,
  per: i.per,
  appliesTo: i.appliesTo,
  validFrom: i.validFrom === null ? null : new Date(i.validFrom),
  validTo: i.validTo === null ? null : new Date(i.validTo),
});

/** True when a database error is the CHECK on a code's redemptions, by its name (any other CHECK is not this one). */
export function isRedeemedCheckViolation(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify((err as { meta?: unknown }).meta ?? {})}` : '';
  return /promo_codes_redeemed_check/.test(text);
}

/** True when a database error is a unique violation (P2002 or 23505). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'P2002') return true;
  const text = err instanceof Error ? `${err.message} ${JSON.stringify((err as { meta?: unknown }).meta ?? {})}` : '';
  return /23505|Unique constraint/.test(text);
}
