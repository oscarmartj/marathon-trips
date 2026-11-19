import { describe, expect, it } from 'vitest';
import { actionsFor, creatableText, credentialsFrom, lostText, statusText, testResultText, warningText } from './gateways-panel';
import { t } from './i18n';

describe('payment gateways page (task 4.1)', () => {
  it('offers exactly the transitions the API lists, in a stable order', () => {
    expect(actionsFor({ allowedTransitions: ['retired', 'active'] }).map((a) => a.to)).toEqual(['active', 'retired']);
    expect(actionsFor({ allowedTransitions: [] })).toEqual([]);
    expect(actionsFor({ allowedTransitions: ['paused', 'retired'] }).map((a) => a.label)).toEqual([t('admin.gateways.action.paused'), t('admin.gateways.action.retired')]);
    for (const s of ['active', 'paused', 'retired', 'archived'] as const) expect(statusText(s).length).toBeGreaterThan(0);
  });

  it('every connection test code and warning has words; an unknown code is generic and never echoed', () => {
    for (const code of ['ok', 'provider_unavailable', 'provider_timeout', 'provider_busy', 'provider_rejected', 'provider_auth_failed', 'provider_not_found', 'webhook_secret_missing', 'manual_instructions_invalid', 'credentials_unreadable']) {
      expect(testResultText(code)).not.toContain('_');
    }
    expect(testResultText(null)).toBe(t('admin.gateways.test.never'));
    expect(testResultText('Invalid API Key sk_test_x')).toBe(t('admin.gateways.test.provider_rejected'));
    const accounts = [{ id: 'a', displayName: 'Stripe test' }];
    for (const code of ['no_method_for_country', 'active_without_current_test', 'webhook_rejected_since_change', 'webhook_secret_missing', 'adapter_missing', 'adapter_planned_with_account']) {
      expect(warningText({ code, accountId: 'a', country: 'AU' }, accounts)).not.toMatch(/\{|_/);
    }
    expect(warningText({ code: 'paused_by_system', accountId: 'a', reason: 'boot_adapter_missing' }, accounts)).toContain('Stripe test');
    expect(warningText({ code: 'something_new', accountId: 'zzz' }, accounts)).toBe(t('admin.gateways.warning.unknown', { account: t('admin.gateways.unnamed') }));
    expect(creatableText({ creatable: false, creatableReason: 'live_mode_not_available' })).toBe(t('admin.gateways.catalogue.reason.live_mode_not_available'));
    expect(creatableText({ creatable: false, creatableReason: 'sk_live_x' })).toBe(t('admin.gateways.catalogue.reason.adapter_unavailable'));
  });

  it('lists the lost method/country pairs and sends only declared, filled-in credential fields', () => {
    expect(lostText([{ method: 'card', country: 'AU' }, { method: 'payid_transfer', country: 'AU' }])).toBe(`${t('admin.gateways.lostPair', { method: 'Card', country: 'AU' })}, ${t('admin.gateways.lostPair', { method: t('admin.gateways.method.payid_transfer'), country: 'AU' })}`);
    const form = new FormData();
    form.set('new-secretKey', 'sk_test_abc');
    form.set('new-other', 'ignored');
    form.set('new-empty', '');
    expect(credentialsFrom(form, [{ key: 'secretKey' }, { key: 'empty' }], 'new-')).toEqual({ secretKey: 'sk_test_abc' });
  });
});
