import { describe, expect, it } from 'vitest';
import '../test/admin-messages';
import { exportBody, exportErrorMessage, forecastQuery, rateText } from './finance-panel';
import { t } from './i18n-admin';

describe('finance panel helpers', () => {
  it.each([
    ['10000000', '0.01'], ['1000000000', '1'], ['1234567890', '1.23456789'], ['0', '0'], ['5', '0.000000005'], ['x', ''], ['-5', ''], ['1.5', ''],
  ])('rateText(%s) is %s', (e9, out) => expect(rateText(e9)).toBe(out));

  it.each([
    ['trip_result', '2026-07-01', '2026-07-31', true], ['ledger', '2026-07-01', '2026-07-31', true], ['supplier_payments', '2026-07-01', '2026-07-31', true],
    ['everything', '2026-07-01', '2026-07-31', false], ['ledger', '', '2026-07-31', false], ['ledger', '2026-07-01', '31/07/2026', false], ['', '', '', false],
  ])('exportBody(%s, %s, %s) ok=%s', (d, f, to, ok) => expect(exportBody(d, f, to) !== null).toBe(ok));

  it.each([['', '', ''], ['2026-07-01', '', '?from=2026-07-01'], ['', '2026-07-31', '?to=2026-07-31'], ['2026-07-01', '2026-07-31', '?from=2026-07-01&to=2026-07-31'], ['junk', '2026-07-31', '?to=2026-07-31']])(
    'forecastQuery(%s, %s)', (f, to, out) => expect(forecastQuery(f, to)).toBe(out));

  it('maps every failure to catalogue copy', () => {
    for (const code of ['range_invalid', 'range_too_long', 'export_too_large', 'validation_failed']) {
      expect(exportErrorMessage({ status: 422, body: { code } })).toBe(t(`admin.tripResults.export.errors.${code}`));
    }
    expect(exportErrorMessage({ status: 429, body: {} })).toBe(t('admin.tripResults.export.errors.rate_limited'));
    expect(exportErrorMessage({ status: 422, body: { code: 'other' } })).toBe(t('admin.tripResults.export.errors.validation_failed'));
    expect(exportErrorMessage({ status: 403, body: {} })).toBe(t('admin.common.forbidden'));
    expect(exportErrorMessage({ status: 500, body: {} })).toBe(t('admin.common.error'));
  });
});
