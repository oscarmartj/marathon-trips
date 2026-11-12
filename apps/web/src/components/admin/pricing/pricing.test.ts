import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messageCatalogue } from '@/lib/i18n';
import { pricingError } from './pricing-kit';

const here = __dirname;
const apiPricing = join(here, '..', '..', '..', '..', '..', 'api', 'src', 'modules', 'pricing');

const has = (key: string): boolean => {
  let node: unknown = messageCatalogue();
  for (const part of key.split('.')) node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined;
  return typeof node === 'string';
};
const sources = readdirSync(here).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts')).filter((f) => !f.endsWith('.test.ts')).map((f) => ({ f, text: readFileSync(join(here, f), 'utf8') }));

describe('pricing panel copy', () => {
  it('every literal message key it uses exists', () => {
    const missing: string[] = [];
    for (const { f, text } of sources) {
      for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) if (!has(m[1]!)) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('every key built from a choice exists for each choice', () => {
    const choices: Array<[string, string[]]> = [
      ['admin.pricing.phases.', ['draft', 'in_force', 'scheduled', 'past', 'archived']],
      ['admin.pricing.detail.phase.', ['draft', 'in_force', 'scheduled', 'past', 'archived']],
      ['admin.pricing.statuses.', ['draft', 'published', 'archived']],
      ['admin.pricing.cellErrors.', ['empty', 'invalid', 'decimals', 'too_large', 'price_needed']],
      ['admin.pricing.formErrors.', ['empty', 'invalid', 'decimals', 'too_large', 'label', 'value', 'percent', 'number', 'date', 'instant', 'code', 'scope', 'priority']],
      ['admin.pricing.kinds.', ['early_bird', 'late_supplement', 'group_discount', 'occupancy_supplement', 'custom']],
      ['admin.pricing.kindHints.', ['early_bird', 'late_supplement', 'group_discount', 'occupancy_supplement', 'custom']],
      ['admin.pricing.directions.', ['discount', 'surcharge']],
      ['admin.pricing.scopes.', ['global', 'edition', 'package', 'globalLong', 'editionUnknown', 'packageUnknown', 'thisPackage', 'thisEdition']],
      ['admin.pricing.effectModes.', ['percent', 'fixed']],
      ['admin.pricing.pers.', ['person', 'booking']],
      ['admin.pricing.persShort.', ['person', 'booking']],
      ['admin.pricing.targets.', ['subtotal', 'accommodation', 'participation', 'extras']],
      ['admin.pricing.targetsShort.', ['subtotal', 'accommodation', 'participation', 'extras']],
      ['admin.pricing.preview.promoStatuses.', ['none', 'applied', 'not_combinable', 'conditions_not_met', 'invalid']],
      ['admin.pricing.preview.outcomes.', ['applied', 'disabled', 'out_of_validity', 'out_of_scope', 'other_currency', 'conditions_not_met', 'filter_matches_nobody', 'blocked_by_non_stackable']],
      ['admin.pricing.list.statuses.', ['archived', 'enabled', 'disabled']],
      ['admin.pricing.publish.blocked.', ['unsaved', 'incomplete']],
      ['admin.pricing.form.rule.', ['new', 'edit', 'create', 'newTitle', 'editTitle']],
      ['admin.pricing.form.promo.', ['new', 'edit', 'create', 'newTitle', 'editTitle']],
      ['admin.pricing.list.rule.', ['title', 'help', 'caption', 'empty']],
      ['admin.pricing.list.promo.', ['title', 'help', 'caption', 'empty']],
      ['admin.catalogue.participation.', ['runner_with_entry', 'runner_own_entry', 'supporter']],
      ['admin.catalogue.pricingUnits.', ['per_person', 'per_booking']],
    ];
    const missing = choices.flatMap(([prefix, keys]) => keys.filter((k) => !has(`${prefix}${k}`)).map((k) => `${prefix}${k}`));
    expect(missing).toEqual([]);
  });

  it('has wording for every error the pricing API can answer with', () => {
    // Codes the services and the engine raise on purpose as 4xx. A code without wording would show the API's own text,
    // which is fine, but it should be a choice: add the wording, or list the code below with the reason.
    const withoutWording = new Set<string>([
      // Internal errors, answered as 500s and never shown as a message.
      'rounding_invalid', 'amount_negative', 'amount_above_limit', 'total_negative', 'total_inconsistent', 'rule_cap_exceeded',
      // Raised when a booking redeems a code (task 2.4), not by anything in the panel.
      'booking_has_promo_code', 'promo_code_changed', 'promo_code_customer_limit', 'promo_code_unavailable',
    ]);
    const codes = new Set<string>();
    const files = [...readdirSync(apiPricing), ...readdirSync(join(apiPricing, 'engine')).map((f) => join('engine', f))].filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const text = readFileSync(join(apiPricing, f), 'utf8');
      for (const m of text.matchAll(/\b(?:conflict|unprocessable|notFound|forbidden)\(\s*'([a-z0-9_]+)'/g)) codes.add(m[1]!);
      for (const m of text.matchAll(/\bfail\(\s*'([a-z0-9_]+)'/g)) codes.add(m[1]!);
    }
    expect(codes.size).toBeGreaterThan(20);
    const missing = [...codes].filter((c) => !withoutWording.has(c) && !has(`admin.pricing.errors.${c}`)).sort();
    expect(missing).toEqual([]);
  });
});

describe('pricingError', () => {
  it('uses the pricing wording for a known code', () => {
    expect(pricingError({ status: 409, body: { code: 'current_version_changed', message: 'The prices changed since you looked. Reload and try again.' } })).toMatch(/Reload, check the timeline/);
    expect(pricingError({ status: 403, body: { code: 'step_up_required' } })).toMatch(/fresh authenticator code/);
  });
  it('lists the fields of a validation failure and never a value', () => {
    expect(pricingError({ status: 422, body: { code: 'validation_failed', message: 'Some fields are not valid', fields: ['label', 'valueBps'] } })).toBe('Some details are not valid: label, valueBps.');
    expect(pricingError({ status: 422, body: { code: 'validation_failed' } })).toMatch(/Check the fields/);
  });
  it('shows the API text for a 409 or 422 code it has no wording for', () => {
    expect(pricingError({ status: 422, body: { code: 'some_new_rule', message: 'The API says this.' } })).toBe('The API says this.');
    expect(pricingError({ status: 409, body: { code: 'another', message: 'Fixed text.' } })).toBe('Fixed text.');
  });
  it('falls back to the general wording otherwise', () => {
    expect(pricingError({ status: 500, body: { code: 'unexpected_error', message: 'An unexpected error occurred' } })).toBe('Something went wrong. Try again.');
    expect(pricingError({ status: 403, body: {} })).toBe('You do not have permission to see this.');
  });
});
