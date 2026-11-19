import { renderToStaticMarkup } from 'react-dom/server';
import { configHeadersFor } from '@/test/next-headers';
import { describe, expect, it } from 'vitest';
import type { AccountBookingItem, PaymentPlanView } from '@mt/shared';
import { AccountBookings } from '@/components/account/account-bookings';
import { BookingOverview, type AccountBookingDetail } from '@/components/account/booking-overview';
import { PayByLink } from '@/components/pay/pay-by-link';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const en = (s: string) => ({ 'en-AU': s });

const item = (over: Partial<AccountBookingItem> = {}): AccountBookingItem => ({
  reference: 'MT-4YRAQQ', status: 'approved', requestedAt: '2026-11-01T00:00:00.000Z', departureDate: '2027-06-18', returnDate: '2027-06-21', currency: 'AUD', totalMinor: '132500',
  package: { name: en('Race weekend'), slug: 'weekend', editionYear: 2027, race: { name: en('Fremantle Run'), slug: 'fremantle' } }, ...over,
});
const plan = (over: Partial<PaymentPlanView> = {}): PaymentPlanView => ({
  reference: 'MT-4YRAQQ', currency: 'AUD', payable: true,
  items: [{ kind: 'deposit', sequence: 1, amountMinor: '100000', dueDate: '2027-01-10', paidMinor: '0' }, { kind: 'balance', sequence: 2, amountMinor: '32500', dueDate: '2027-04-18', paidMinor: '0' }],
  collectedMinor: '0', outstandingMinor: '132500', overpaidMinor: '0', depositDueBy: null, nextPayable: { sequence: 1, amountMinor: '100000' }, methods: ['card'], liveAttempt: null, manualIntent: null, ...over,
});
const detail = (over: Partial<AccountBookingDetail> = {}, status = 'approved'): AccountBookingDetail => ({
  booking: {
    reference: 'MT-4YRAQQ', status, departureDate: '2027-06-18', returnDate: '2027-06-21', currency: 'AUD', totalMinor: '132500', depositMinor: '100000',
    package: { name: en('Race weekend'), editionYear: 2027, race: { name: en('Fremantle Run') } },
    price: { subtotals: { accommodation: '90000', participation: '42500', extras: '0' } },
  },
  plan: plan(), payments: [], documents: [], ...over,
});

describe('customer area pages', () => {
  it('the list shows what the API sent and links each booking', () => {
    const html = renderToStaticMarkup(<AccountBookings items={[item(), item({ reference: 'MT-4YRAQR', status: 'requested', totalMinor: '5000' })]} />);
    expect(html).toContain('href="/account/bookings/MT-4YRAQQ"');
    expect(text(html)).toContain('$1,325.00');
    expect(text(html)).toContain('$50.00');
    expect(text(html)).toContain('Fremantle Run 2027: Race weekend');
    expect(text(renderToStaticMarkup(<AccountBookings items={[]} />))).toContain('You have no bookings yet.');
  });

  it('the booking shows the API amounts untouched, never adding up the plan', () => {
    const t = text(renderToStaticMarkup(<BookingOverview view={detail({ plan: plan({ outstandingMinor: '98765' }) })} />));
    expect(t).toContain('$1,325.00');
    expect(t).toContain('Still to pay: $987.65');
    expect(t).toContain('Pay $1,000.00 now');
    expect(t).toContain('$900.00');
  });

  it('pay now only when the API says the booking is payable', () => {
    const payable = renderToStaticMarkup(<BookingOverview view={detail()} />);
    expect(payable).toContain('href="/checkout/MT-4YRAQQ"');
    const not = renderToStaticMarkup(<BookingOverview view={detail({ plan: plan({ payable: false, notPayableReason: 'approval_expired', nextPayable: null }) })} />);
    expect(not).not.toContain('/checkout/');
    expect(text(not)).toContain('The time to pay the deposit for this booking has run out.');
  });

  it('documents are download links to the API, and receipts are never offered', () => {
    const html = renderToStaticMarkup(<BookingOverview view={detail({ documents: ['confirmation', 'itinerary', 'receipt'] }, 'confirmed')} />);
    expect(html).toContain('href="/api/account/bookings/MT-4YRAQQ/documents/confirmation"');
    expect(html).toContain('href="/api/account/bookings/MT-4YRAQQ/documents/itinerary"');
    expect(html).not.toContain('documents/receipt');
    expect(text(html)).toContain('It is not a receipt or a tax invoice.');
    expect(text(renderToStaticMarkup(<BookingOverview view={detail()} />))).toContain('Your documents appear here once your booking is confirmed.');
  });

  it('payments received are listed with their method; the plan is a table with headers', () => {
    const html = renderToStaticMarkup(<BookingOverview view={detail({ payments: [{ succeededAt: '2026-11-13T00:30:00.000Z', amountMinor: '100000', currency: 'AUD', method: 'card' }] })} />);
    expect(text(html)).toContain('$1,000.00 on 13 November 2026');
    expect(text(html)).toContain('Credit or debit card');
    expect(html).toMatch(/<th scope="col">/);
    expect(html).toMatch(/<caption/);
  });

  it('the pay page starts by reading the link, with no amount or form before the API answers', () => {
    const t = text(renderToStaticMarkup(<PayByLink />));
    expect(t).toContain('Checking your link');
    expect(t).not.toMatch(/\$\d/);
  });

  it('the pay pages are not framed and send no Referer (next.config)', async () => {
    // Task 8.5: evaluated as Next.js applies the rules, instead of matching the file's text (src/lib/security-headers.test.ts).
    for (const path of ['/pay', '/pay/return']) {
      const h = await configHeadersFor(path);
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['x-frame-options']).toBe('DENY');
    }
  });
});
