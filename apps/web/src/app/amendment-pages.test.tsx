import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PaymentPlanView } from '@mt/shared';
import { BookingOverview, type AccountBookingDetail } from '@/components/account/booking-overview';
import { AmendmentHistory, PreviewSummary } from '@/components/admin/crm/amendments';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const en = (s: string) => ({ 'en-AU': s });
const plan = (over: Partial<PaymentPlanView> = {}): PaymentPlanView => ({
  reference: 'MT-4YRAQQ', currency: 'AUD', payable: true,
  items: [{ kind: 'deposit', sequence: 1, amountMinor: '100000', dueDate: '2027-01-10', paidMinor: '100000' }, { kind: 'adjustment', sequence: 2, amountMinor: '30000', dueDate: '2026-11-25', paidMinor: '0' }],
  collectedMinor: '100000', outstandingMinor: '62500', overpaidMinor: '0', depositDueBy: null, nextPayable: { sequence: 2, amountMinor: '30000' }, methods: ['card'], liveAttempt: null, manualIntent: null, ...over,
});
const detail = (over: Partial<AccountBookingDetail> = {}): AccountBookingDetail => ({
  booking: {
    reference: 'MT-4YRAQQ', status: 'confirmed', departureDate: '2027-06-18', returnDate: '2027-06-22', currency: 'AUD', totalMinor: '162500', depositMinor: '150000',
    package: { name: en('Race weekend'), editionYear: 2027, race: { name: en('Fremantle Run') } }, price: {},
  },
  plan: plan(), payments: [], documents: [],
  changes: { items: [{ version: 2, at: '2026-11-18T00:00:00.000Z', by: 'staff', changes: ['nights'], currency: 'AUD', previousTotalMinor: '132500', newTotalMinor: '162500', priceDifferenceMinor: '30000' }], customerChangesEnabled: false },
  ...over,
});

describe('changes in the customer area and the panel (task 6.3)', () => {
  it('the history shows the API amounts as sent; the deposit shown is the plan item, not the new snapshot deposit (review m4)', () => {
    const t = text(renderToStaticMarkup(<BookingOverview view={detail()} />));
    expect(t).toContain('changed by our team (extra nights). Total $1,325.00 → $1,625.00, a difference of $300.00');
    expect(t).toContain('Adjustment');
    expect(t).toContain('$1,000.00');
    expect(t).not.toContain('$1,500.00');
    expect(t).toContain('To change this booking, contact us.');
  });

  it('a credit pending is the current plan value, shown as pending and never as refunded (review M6)', () => {
    const none = text(renderToStaticMarkup(<BookingOverview view={detail()} />));
    expect(none).not.toContain('We owe you');
    const t = text(renderToStaticMarkup(<BookingOverview view={detail({ plan: plan({ overpaidMinor: '17500' }) })} />));
    expect(t).toContain('We owe you $175.00 after a change. Refunds are not available online yet: this credit is pending');
    expect(t).not.toMatch(/refunded/i);
  });

  it('the change link appears only when the API says online changes are on', () => {
    const html = renderToStaticMarkup(<BookingOverview view={detail({ changes: { items: [], customerChangesEnabled: true } })} />);
    expect(html).toContain('href="/account/bookings/MT-4YRAQQ/change"');
    expect(renderToStaticMarkup(<BookingOverview view={detail()} />)).not.toContain('/change"');
  });

  it('the panel history is a table with headers and the current credit as a status', () => {
    const html = renderToStaticMarkup(<AmendmentHistory currency="AUD" creditNowMinor="17500" rows={[{ id: 'a', toVersion: 2, createdAt: '2026-11-18T00:00:00.000Z', initiatedBy: 'customer', changes: ['extras'], currency: 'AUD', previousTotalMinor: '132500', newTotalMinor: '110000', priceDifferenceMinor: '-22500', outstandingMinor: '0', creditPendingMinor: '17500' }]} />);
    expect(html).toMatch(/<th scope="col">/);
    expect(html).toContain('role="status"');
    expect(text(html)).toContain('-$225.00');
    expect(text(html)).toContain('Credit pending now: $175.00');
  });

  it('the preview shows the engine numbers untouched (a total that does not add up is shown as sent)', () => {
    const t = text(renderToStaticMarkup(<PreviewSummary preview={{ fromVersion: 1, changes: ['nights'], previousTotalMinor: '132500', newTotalMinor: '999999', priceDifferenceMinor: '30000', collectedMinor: '100000', outstandingAfterMinor: '62500', creditPendingAfterMinor: '0', basisDriftMinor: '0', currency: 'AUD', departureDate: '2027-06-18', returnDate: '2027-06-22', previewDigest: 'x', price: { lines: [], totalMinor: '999999', promo: { status: 'none' } } }} />));
    expect(t).toContain('$9,999.99');
    expect(t).toContain('$300.00');
    expect(t).toContain('$625.00');
  });
});
