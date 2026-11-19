import { describe, expect, it } from 'vitest';
import en from '../../messages/en-AU.json';
import { PAYMENT_ERROR_CODES, SCHEDULE_BUCKETS, bucketLabel, paymentErrorMessage, recordBody } from './supplier-payments';

const get = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);

describe('supplier payment pages (task 6.2)', () => {
  it('every error code, bucket and label has its Australian English text', () => {
    for (const code of PAYMENT_ERROR_CODES) expect(typeof get(`admin.suppliers.payments.errors.${code}`)).toBe('string');
    for (const b of SCHEDULE_BUCKETS) expect(typeof get(`admin.supplierSchedule.buckets.${b}`)).toBe('string');
    for (const k of ['paid', 'ownMoney', 'otherCurrencyPaid', 'unlinkedHeading', 'unlinkedRow']) expect(typeof get(`admin.customerMoney.${k}`)).toBe('string');
    expect(get('admin.nav.supplierPayments')).toBe('Supplier payments');
  });

  it('says plainly that recording sends no money', () => {
    expect(get('admin.suppliers.payments.notice')).toMatch(/does not send any money/);
    expect(get('admin.supplierSchedule.intro')).toMatch(/does not send money/);
  });

  it('maps known codes and falls back for unknown ones', () => {
    expect(paymentErrorMessage('cost_item_already_paid')).toMatch(/already paid/);
    expect(paymentErrorMessage('version_conflict')).toBe(get('admin.catalogue.errors.version_conflict'));
    expect(paymentErrorMessage('bad_amount')).toBe(get('admin.suppliers.errors.bad_amount'));
    expect(paymentErrorMessage('something_else')).toBe(get('admin.common.error'));
    expect(paymentErrorMessage(undefined)).toBe(get('admin.common.error'));
    expect(bucketLabel('upcoming', 7)).toBe('Next 7 days');
  });

  it('builds the body without any amount of its own; the bank amount is parsed in its currency', () => {
    expect(recordBody([], '2026-11-20', 'INV', '', '')).toEqual({ error: get('admin.suppliers.payments.chooseFirst') });
    const plain = recordBody([{ id: 'a', version: 2 }], '2026-11-20', ' INV-1 ', '', '');
    expect(plain).toEqual({ items: [{ costItemId: 'a', version: 2 }], paidOn: '2026-11-20', reference: 'INV-1', base: null });
    expect(JSON.stringify(plain)).not.toMatch(/amountMinor/);
    expect(recordBody([{ id: 'a', version: 0 }], '2026-11-20', 'INV', '1,250.50', 'aud')).toMatchObject({ base: { amountMinor: '125050', currency: 'AUD' } });
    expect(recordBody([{ id: 'a', version: 0 }], '2026-11-20', 'INV', '15000', 'JPY')).toMatchObject({ base: { amountMinor: '15000', currency: 'JPY' } });
    for (const [amount, cur] of [['12.345', 'AUD'], ['0', 'AUD'], ['abc', 'AUD'], ['10', 'AU'], ['1.5', 'JPY']]) {
      expect(recordBody([{ id: 'a', version: 0 }], '2026-11-20', 'INV', amount!, cur!)).toHaveProperty('error');
    }
  });
});
