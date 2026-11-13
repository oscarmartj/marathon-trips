import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CheckoutTermsView, PaymentPlanView } from '@mt/shared';
import { CheckoutForm } from '@/components/checkout/checkout-form';
import { PaymentReturn } from '@/components/checkout/payment-return';
import { RequestConfirmation, type RequestView } from '@/components/booking/request-confirmation';

const plan = (over: Partial<PaymentPlanView> = {}): PaymentPlanView => ({
  reference: 'MT-4YRAQQ', currency: 'AUD', payable: true,
  items: [{ kind: 'deposit', sequence: 1, amountMinor: '100000', dueDate: '2027-01-10', paidMinor: '0' }, { kind: 'balance', sequence: 2, amountMinor: '32500', dueDate: '2027-04-18', paidMinor: '0' }],
  collectedMinor: '0', outstandingMinor: '132500', overpaidMinor: '0', depositDueBy: '2026-12-01T13:59:59.000Z', nextPayable: { sequence: 1, amountMinor: '100000' },
  methods: ['card', 'payid_transfer'], liveAttempt: null, ...over,
});
const terms = (over: Partial<CheckoutTermsView> = {}): CheckoutTermsView => ({ slug: 'terms', version: 7, digest: 'a'.repeat(64), title: 'Terms of booking', intro: 'Read first.', body: 'One clause.\n\nAnother clause.', acceptedAt: null, ...over });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('checkout page', () => {
  it('shows_the_apis_amounts_untouched_and_only_the_methods_it_sends', () => {
    const html = renderToStaticMarkup(<CheckoutForm plan={plan()} initialTerms={terms()} />);
    const t = text(html);
    expect(t).toContain('$1,000.00');
    expect(t).toContain('$325.00');
    expect(t).toContain('You will pay $1,000.00 now.');
    expect(t).toContain('Credit or debit card');
    expect(t).toContain('PayID or bank transfer');
    expect(t).not.toContain('Apple Pay');
    expect(t).not.toContain('Pay later');
    // The balance and total are never added up here: no $1,325.00.
    expect(t).not.toContain('$1,325.00');
  });

  it('a_live_attempt_is_shown_and_its_method_preselected', () => {
    const live = { status: 'requires_action' as const, method: 'payid_transfer' as const, amountMinor: '100000', currency: 'AUD' };
    const html = renderToStaticMarkup(<CheckoutForm plan={plan({ liveAttempt: live })} initialTerms={terms()} />);
    expect(text(html)).toContain('A payment is already waiting for you.');
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios.filter((r) => /checked/.test(r)).map((r) => /value="([a-z_]+)"/.exec(r)![1])).toEqual(['payid_transfer']);
    const created = text(renderToStaticMarkup(<CheckoutForm plan={plan({ liveAttempt: { ...live, status: 'created' } })} initialTerms={terms()} />));
    expect(created).toContain('A payment is already waiting for you.');
    const pending = text(renderToStaticMarkup(<CheckoutForm plan={plan({ liveAttempt: { ...live, status: 'pending' } })} initialTerms={terms()} />));
    expect(pending).toContain('is being processed');
  });

  it('a_changed_amount_from_the_api_is_shown_as_sent', () => {
    const t = text(renderToStaticMarkup(<CheckoutForm plan={plan({ nextPayable: { sequence: 1, amountMinor: '98765' } })} initialTerms={terms()} />));
    expect(t).toContain('You will pay $987.65 now.');
  });

  it('terms_are_shown_with_their_version_and_a_checkbox_that_is_not_ticked_until_accepted', () => {
    const html = renderToStaticMarkup(<CheckoutForm plan={plan()} initialTerms={terms()} />);
    expect(text(html)).toContain('Terms version 7');
    expect(text(html)).toContain('I have read and accept the booking terms (version 7).');
    expect(text(html)).toContain('Another clause.');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="terms"/);
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  });

  it('already_accepted_terms_show_the_date_in_brisbane_time_and_the_box_is_ticked', () => {
    const html = renderToStaticMarkup(<CheckoutForm plan={plan()} initialTerms={terms({ acceptedAt: '2026-11-13T00:30:00.000Z' })} />);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(text(html)).toContain('You accepted these terms on 13 November 2026');
    expect(text(html)).toMatch(/10:30\s?am/i);
  });

  it('is_accessible_by_structure: a fieldset with a legend, labelled radios, a labelled checkbox, a focusable terms region, one submit button', () => {
    const html = renderToStaticMarkup(<CheckoutForm plan={plan()} initialTerms={terms()} />);
    expect(html).toContain('<legend>Payment method</legend>');
    expect((html.match(/<label class="choice"><input type="radio"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/<label class="choice"><input type="checkbox"/);
    expect(html).toMatch(/class="terms-text" tabindex="0" role="region" aria-label="Text of the booking terms"/);
    expect((html.match(/type="submit"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('<h1');
  });

  it('says_card_details_are_entered_on_the_providers_page_and_makes_no_official_claims', () => {
    const t = text(renderToStaticMarkup(<CheckoutForm plan={plan()} initialTerms={terms()} />));
    expect(t).toContain("We never see or store them.");
    expect(t).not.toMatch(/official|guarantee|accredit|surcharge/i);
    // No field takes a card number or an amount.
    const html = renderToStaticMarkup(<CheckoutForm plan={plan()} initialTerms={terms()} />);
    expect(html).not.toMatch(/name="(card|cardNumber|cvc|amount)/i);
  });
});

describe('return page', () => {
  it('starts_by_checking_and_claims_nothing_before_the_api_answers', () => {
    const t = text(renderToStaticMarkup(<PaymentReturn reference="MT-4YRAQQ" />));
    expect(t.trim()).toBe('Checking your payment…');
  });
});

describe('request page link', () => {
  const view = (status: string): RequestView => ({ reference: 'MT-4YRAQQ', status, isRequest: false, requestExpiresAt: '2026-11-19T09:23:33.035Z', departureDate: '2027-06-18', returnDate: '2027-06-21', balanceDueDate: '2027-04-18', currency: 'AUD', totalMinor: '132500', depositMinor: '100000', package: { name: { 'en-AU': 'Race weekend' } } });
  it.each([['approved', true], ['deposit_paid', true], ['requested', false], ['declined', false], ['expired', false], ['confirmed', false]])('%s has the payment link: %s', (status, has) => {
    const html = renderToStaticMarkup(<RequestConfirmation view={view(status)} />);
    expect(html.includes('href="/checkout/MT-4YRAQQ"')).toBe(has);
  });
});
