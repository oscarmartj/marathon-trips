// Payment routing rules on the "Payment gateways" page (task 4.2, plan docs/plans/4.2-routing-rules.md, section 9).
// Pure, so it is tested without a browser. The API decides what is valid and which account takes a payment; the page
// only turns typed dollars into an integer string of cents (no floats) and the API's codes into words.
import { t } from './i18n';
import { formatMinor, parseMoney } from './pricing-panel';

export interface RuleView {
  id: string;
  providerAccountId: string;
  accountName: string;
  accountStatus: string;
  method: string;
  countries: string[] | null;
  currency: string;
  minAmountMinor: string | null;
  maxAmountMinor: string | null;
  priority: number;
  enabled: boolean;
  fallbackForRuleId: string | null;
  matchesAdapter: boolean;
  version: number;
}

export type RoutingWarning = { code: string; accountId?: string; method?: string; country?: string; ruleId?: string; bookingIds?: string[]; gaps?: Array<{ fromMinor: string; toMinor: string }>; until?: string | null };

const KNOWN_WARNINGS = new Set([
  'account_unreachable', 'account_auth_failed', 'method_unreachable_now', 'method_limited_by_amount', 'active_account_without_rules',
  'rule_outside_adapter_capabilities', 'fallback_target_disabled', 'live_attempts_on_unreachable_account',
]);
const KNOWN_REASONS = new Set([
  'disabled', 'method', 'currency', 'country', 'below_min', 'above_max', 'outside_adapter', 'account_not_active', 'adapter_blocked', 'manual_off',
  'unreachable', 'primary_serving', 'primary_not_matching',
]);
export const RULE_ERRORS = [
  'rule_method_not_supported', 'rule_currency_not_supported', 'rule_country_not_supported', 'rule_countries_invalid', 'rule_amount_invalid', 'rule_limits_inverted',
  'rule_priority_invalid', 'fallback_target_missing', 'fallback_target_is_fallback', 'fallback_mismatch', 'fallback_same_account', 'fallback_self', 'rule_is_fallback_target',
  'rule_has_fallbacks', 'account_not_accepting_charges', 'version_conflict',
] as const;

/** A typed limit in dollars to an integer string of cents; empty means no limit. */
export function limitFrom(text: string): { ok: true; minor: string | null } | { ok: false } {
  if (text.trim() === '') return { ok: true, minor: null };
  const r = parseMoney(text);
  return r.ok ? { ok: true, minor: r.minor } : { ok: false };
}

/** "AU, NZ" to ['AU', 'NZ']; empty means any country. Letters are upper-cased; the API checks the codes. */
export function countriesFrom(text: string): string[] | null {
  const list = text.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter((c) => c !== '');
  return list.length === 0 ? null : list;
}

export const countriesText = (countries: string[] | null): string => (countries === null ? t('admin.routing.anyCountry') : countries.join(', '));

export function limitsText(r: Pick<RuleView, 'minAmountMinor' | 'maxAmountMinor' | 'currency'>): string {
  if (r.minAmountMinor === null && r.maxAmountMinor === null) return t('admin.routing.noLimits');
  const min = r.minAmountMinor === null ? t('admin.routing.noMin') : formatMinor(r.minAmountMinor, r.currency);
  const max = r.maxAmountMinor === null ? t('admin.routing.noMax') : formatMinor(r.maxAmountMinor, r.currency);
  return t('admin.routing.limitsRange', { min, max });
}

export const reasonText = (code: string | null): string => (code === null ? t('admin.routing.preview.takes') : t(`admin.routing.reason.${KNOWN_REASONS.has(code) ? code : 'unknown'}`));

export const ruleErrorText = (code: string): string | null => ((RULE_ERRORS as readonly string[]).includes(code) ? t(`admin.routing.errors.${code}`) : null);

/** A routing warning in words, naming accounts by their display names (never anything secret). */
export function routingWarningText(w: RoutingWarning, accounts: ReadonlyArray<{ id: string; displayName: string }>): string {
  const code = KNOWN_WARNINGS.has(w.code) ? w.code : 'unknown';
  const account = accounts.find((a) => a.id === w.accountId)?.displayName ?? t('admin.gateways.unnamed');
  const method = w.method ? t(`admin.gateways.method.${w.method}`) : '';
  const gaps = (w.gaps ?? []).map((g) => t('admin.routing.limitsRange', { min: formatMinor(g.fromMinor), max: formatMinor(g.toMinor) })).join(', ');
  return t(`admin.routing.warning.${code}`, { account, method, country: w.country ?? '', count: String(w.bookingIds?.length ?? 0), gaps });
}
