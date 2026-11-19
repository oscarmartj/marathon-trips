import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accountsOf, adminReceiptHref, differenceLabel, moneyOrDash, runStatusLabel, sideText } from './reconciliation-panel';
import { receiptHref } from './account';

describe('reconciliation, customer money and receipts panels (task 4.6)', () => {
  it('labels every status and difference code, and formats the sides as the API sent them', () => {
    expect(runStatusLabel('mismatch')).toBe('differences found');
    expect(runStatusLabel('weird')).toBe('weird');
    expect(differenceLabel('unknown_gateway_refund')).toBe('Refund at the gateway the app does not know');
    expect(differenceLabel('made_up')).toBe('made_up');
    expect(sideText({ status: 'succeeded', amountMinor: '123456', currency: 'AUD' })).toBe('succeeded, $1,234.56');
    expect(sideText({ amountMinor: '-500', currency: 'AUD' })).toBe('-$5.00');
    expect(sideText(undefined)).toBeNull();
    expect(moneyOrDash(null, 'AUD')).toBe('not shown');
    expect(accountsOf([{ id: 'r1', providerAccountId: 'a', accountName: 'Sim', forDate: '2026-11-20', attempt: 2, trigger: 'manual', status: 'matched', errorCode: null, checkedObjects: 1, differenceCount: 0 },
      { id: 'r2', providerAccountId: 'a', accountName: 'Sim', forDate: '2026-11-20', attempt: 1, trigger: 'scheduled', status: 'matched', errorCode: null, checkedObjects: 1, differenceCount: 0 }])).toEqual([{ id: 'a', name: 'Sim' }]);
  });

  it('download links only for document numbers', () => {
    expect(adminReceiptHref('MT-T-7')).toBe('/api/admin/payments/receipts/MT-T-7');
    expect(adminReceiptHref('MT-X-7')).toBeNull();
    expect(receiptHref('MT-4YRAQQ', 'MT-R-1')).toBe('/api/account/bookings/MT-4YRAQQ/receipts/MT-R-1');
    expect(receiptHref('MT-4YRAQQ', 'MT-T-0')).toBeNull();
    expect(receiptHref('bad', 'MT-T-1')).toBeNull();
  });

  it('no_tax_invoice_or_gst_in_web_copy while GST registration cannot be switched on (review R12 g)', () => {
    const messages = readFileSync(new URL('../../messages/en-AU.json', import.meta.url), 'utf8');
    expect(/tax invoice/i.test(messages)).toBe(false);
    expect(/\bGST\b/.test(messages)).toBe(false);
  });
});
