import { describe, expect, it } from 'vitest';
import { startPaymentSchema } from '@mt/shared';
import { acceptTermsBody, checkoutErrorKey, isBookingReference, notPayableKey, outcomeOf, safeRedirect, startPaymentBody } from './checkout';
import { messageCatalogue, t } from './i18n';

describe('checkout request bodies', () => {
  it('start_body_is_only_a_method: no amount, currency, date, card or rule key can be in it', () => {
    const body = startPaymentBody('card');
    expect(body).toEqual({ method: 'card' });
    expect(startPaymentSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body)).toEqual(['method']);
  });

  it('accept_body_carries_the_version_and_digest_the_server_gave, nothing else', () => {
    expect(acceptTermsBody({ version: 3, digest: 'a'.repeat(64) })).toEqual({ version: 3, digest: 'a'.repeat(64) });
    expect(() => acceptTermsBody({ version: 3, digest: 'not a digest' })).toThrow();
    expect(() => acceptTermsBody({ version: -1, digest: 'a'.repeat(64) })).toThrow();
  });
});

describe('where the browser may be sent', () => {
  it.each([
    ['https://pay.example.com/c/abc', 'https://pay.example.com/c/abc'],
    ['http://localhost:3000/api/payments/simulator/checkout/tok', 'http://localhost:3000/api/payments/simulator/checkout/tok'],
    ['http://127.0.0.1:4000/x', 'http://127.0.0.1:4000/x'],
  ])('redirect_allows %s', (url, expected) => expect(safeRedirect(url)).toBe(expected));

  it.each([
    'javascript:alert(1)', 'data:text/html,<script>1</script>', '/relative/path', '//evil.example/x', 'http://evil.example/x', 'http://localhost.evil.example/x',
    'https://user:pass@pay.example.com/x', 'ftp://pay.example.com', '', 'not a url',
  ])('redirect_refuses %s', (url) => expect(safeRedirect(url)).toBeNull());

  it('redirect_refuses_non_strings_and_very_long_addresses', () => {
    expect(safeRedirect(undefined)).toBeNull();
    expect(safeRedirect(42)).toBeNull();
    expect(safeRedirect(`https://pay.example.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('references and messages', () => {
  it('only a booking reference names a booking', () => {
    expect(isBookingReference('MT-4YRAQQ')).toBe(true);
    for (const bad of ['MT-4YRAQ', 'mt-4yraqq', 'MT-4YRAQI', 'QT-4YRAQQ', 'MT-4YRAQQ/../x', '', undefined, ['MT-4YRAQQ']]) expect(isBookingReference(bad)).toBe(false);
  });

  it('every error the API can answer has words, and unknown ones fall back to the generic message', () => {
    const errors = (messageCatalogue().checkout as { errors: Record<string, string> }).errors;
    for (const [status, code] of [[401, undefined], [429, undefined], [409, 'terms_changed'], [409, 'terms_unavailable'], [409, 'terms_not_accepted'], [409, 'no_payment_method_available'], [409, 'approval_expired'], [409, 'booking_not_payable'], [409, 'nothing_to_pay'], [409, 'payment_attempt_in_progress'], [409, 'payment_already_recorded'], [503, 'provider_unavailable'], [409, 'busy_try_again'], [500, 'whatever'], [503, undefined]] as const) {
      expect(errors[checkoutErrorKey(status, code)], `${status} ${code}`).toBeTruthy();
    }
    expect(checkoutErrorKey(500, 'something_new')).toBe('generic');
    const reasons = (messageCatalogue().checkout as { notPayable: Record<string, string> }).notPayable;
    for (const r of ['booking_not_payable', 'approval_expired', 'nothing_to_pay', 'no_payment_method_available', undefined, 'unknown']) expect(reasons[notPayableKey(r)]).toBeTruthy();
  });

  it('no payment method has a surcharge or an official-partner claim in its words', () => {
    const text = JSON.stringify(messageCatalogue().checkout) + JSON.stringify(messageCatalogue().paymentReturn);
    expect(text).not.toMatch(/surcharge|fee|official|guarantee|accredit/i);
    expect(t('checkout.payNow', { amount: '$10.00' })).toBe('You will pay $10.00 now.');
  });
});

describe('what the return page may say', () => {
  const view = (status: string | null) => ({ bookingStatus: 'approved', attempt: status ? { status, method: 'card', amountMinor: '100', currency: 'AUD' } : null }) as Parameters<typeof outcomeOf>[0];
  it.each([
    ['succeeded', 'paid'], ['created', 'processing'], ['pending', 'processing'], ['requires_action', 'processing'],
    ['failed', 'failed'], ['cancelled', 'failed'], ['expired', 'failed'], ['voided', 'failed'], [null, 'none'],
  ])('%s is %s', (status, expected) => expect(outcomeOf(view(status))).toBe(expected));
});
