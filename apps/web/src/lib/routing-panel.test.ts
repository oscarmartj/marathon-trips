import { describe, expect, it } from 'vitest';
import { t } from './i18n';
import { RULE_ERRORS, countriesFrom, countriesText, limitFrom, limitsText, reasonText, routingWarningText, ruleErrorText } from './routing-panel';

describe('routing rules on the gateways page (task 4.2)', () => {
  it('limits_parsed_without_floats: dollars become an integer string of cents; anything else is refused', () => {
    expect(limitFrom('')).toEqual({ ok: true, minor: null });
    expect(limitFrom('1500')).toEqual({ ok: true, minor: '150000' });
    expect(limitFrom('1,500.50')).toEqual({ ok: true, minor: '150050' });
    expect(limitFrom('0.10')).toEqual({ ok: true, minor: '10' });
    for (const bad of ['1.005', '-1', '1e3', 'abc', '1.2.3']) expect(limitFrom(bad)).toEqual({ ok: false });
  });

  it('countries: empty is any country; codes are upper-cased and split on commas or spaces', () => {
    expect(countriesFrom('  ')).toBeNull();
    expect(countriesFrom('au, nz  fj')).toEqual(['AU', 'NZ', 'FJ']);
    expect(countriesText(null)).toBe(t('admin.routing.anyCountry'));
    expect(countriesText(['AU', 'NZ'])).toBe('AU, NZ');
  });

  it('limits read as a range in dollars', () => {
    expect(limitsText({ minAmountMinor: null, maxAmountMinor: null, currency: 'AUD' })).toBe(t('admin.routing.noLimits'));
    expect(limitsText({ minAmountMinor: '100', maxAmountMinor: '150000', currency: 'AUD' })).toBe('A$1.00 to A$1,500.00');
  });

  it('every reason, error and warning code has words; unknown codes stay generic and are never echoed', () => {
    for (const code of ['disabled', 'method', 'currency', 'country', 'below_min', 'above_max', 'outside_adapter', 'account_not_active', 'adapter_blocked', 'manual_off', 'unreachable', 'primary_serving', 'primary_not_matching']) {
      expect(reasonText(code)).not.toMatch(/_|\{/);
    }
    expect(reasonText(null)).toBe(t('admin.routing.preview.takes'));
    expect(reasonText('sk_live_x')).toBe(t('admin.routing.reason.unknown'));
    for (const code of RULE_ERRORS) expect(ruleErrorText(code)).not.toMatch(/_|\{/);
    expect(ruleErrorText('something_else')).toBeNull();
    const accounts = [{ id: 'a', displayName: 'Card account' }];
    for (const code of ['account_unreachable', 'account_auth_failed', 'method_unreachable_now', 'method_limited_by_amount', 'active_account_without_rules', 'rule_outside_adapter_capabilities', 'fallback_target_disabled', 'live_attempts_on_unreachable_account', 'whatever']) {
      expect(routingWarningText({ code, accountId: 'a', method: 'card', country: 'AU', bookingIds: ['x'], gaps: [{ fromMinor: '50001', toMinor: '1000000000000' }] }, accounts)).not.toMatch(/\{|_/);
    }
    expect(routingWarningText({ code: 'method_limited_by_amount', method: 'card', country: 'AU', gaps: [{ fromMinor: '50001', toMinor: '60000' }] }, accounts)).toContain('A$500.01 to A$600.00');
  });
});
