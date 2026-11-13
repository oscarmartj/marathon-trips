import { describe, expect, it } from 'vitest';
import { BOOKING_STATUSES } from '@mt/shared';
import { BOOKING_STATUS_KEYS, documentHref, linkOutcome, payByLinkBody, payLinkErrorKey, statusKey } from './account';
import { t } from './i18n';

const TOKEN = 'A'.repeat(43);

describe('customer area helpers', () => {
  it('status_label_matrix: every booking status has its own words, and none says confirmed before it is', () => {
    expect([...BOOKING_STATUS_KEYS].sort()).toEqual([...BOOKING_STATUSES].sort());
    for (const s of BOOKING_STATUSES) {
      const words = t(`account.status.${statusKey(s)}`);
      expect(words.length).toBeGreaterThan(0);
      const confirmed = /\bconfirmed\b/i.test(words.replace(/not (a )?confirmed/gi, '').replace(/confirm your booking/gi, ''));
      expect([s, confirmed]).toEqual([s, ['confirmed', 'balance_paid'].includes(s)]);
    }
    expect(t('account.status.deposit_paid')).toMatch(/not confirmed yet/);
    expect(statusKey('something_new')).toBe('unknown');
  });

  it('document links go to the API under the reference, for the three kinds only', () => {
    expect(documentHref('MT-4YRAQQ', 'confirmation')).toBe('/api/account/bookings/MT-4YRAQQ/documents/confirmation');
    expect(documentHref('MT-4YRAQQ', 'receipt')).toBeNull();
    expect(documentHref('../x', 'voucher')).toBeNull();
  });

  it('pay_by_link_body_is_only_token_and_method', () => {
    expect(payByLinkBody(TOKEN, 'card')).toEqual({ token: TOKEN, method: 'card' });
    expect(() => payByLinkBody('short', 'card')).toThrow();
  });

  it('maps the payment link answers to messages that exist', () => {
    const cases: Array<[number, string | undefined, string]> = [
      [404, 'payment_link_not_found', 'notFound'], [429, undefined, 'tooMany'], [409, 'terms_not_accepted', 'terms_not_accepted'],
      [409, 'payment_attempt_in_progress', 'payment_attempt_in_progress'], [503, undefined, 'provider_unavailable'], [500, undefined, 'generic'],
    ];
    for (const [status, code, key] of cases) {
      expect(payLinkErrorKey(status, code)).toBe(key);
      expect(t(`payLink.errors.${key}`).length).toBeGreaterThan(0);
    }
  });

  it('the return page says paid only when the API says so', () => {
    expect(linkOutcome({ used: true, attempt: null })).toBe('paid');
    expect(linkOutcome({ used: false, attempt: { status: 'succeeded', method: 'card', amountMinor: '1', currency: 'AUD' } })).toBe('paid');
    expect(linkOutcome({ used: false, attempt: { status: 'requires_action', method: 'card', amountMinor: '1', currency: 'AUD' } })).toBe('processing');
    expect(linkOutcome({ used: false, attempt: { status: 'failed', method: 'card', amountMinor: '1', currency: 'AUD' } })).toBe('failed');
    expect(linkOutcome({ used: false, attempt: null })).toBe('none');
  });
});
