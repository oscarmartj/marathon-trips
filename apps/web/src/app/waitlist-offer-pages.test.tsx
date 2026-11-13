import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WaitlistConfirmation } from '@/components/booking/waitlist-confirmation';
import { WaitlistOfferView, type WaitlistEntryView } from '@/components/booking/waitlist-offer-view';
import { adminRoutes, publicRoutes } from '@/lib/routes';

const view = (over: Partial<WaitlistEntryView> = {}): WaitlistEntryView => ({
  id: '0195f7a0-0000-7000-8000-000000000001', status: 'offered', reason: 'sold_out', offerExpiresAt: '2026-11-19T09:23:33.035Z', bookingReference: null,
  package: { name: { 'en-AU': 'Race weekend' } }, price: { currency: 'AUD', totalMinor: '132500', depositMinor: '100000', balanceDueDate: '2027-04-18' }, ...over,
});
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('waiting list offer page (task 6.5)', () => {
  it('waitlist_offer_page_says_request_not_booking: an offer shows the API price, until when it is held, and both choices', () => {
    const html = renderToStaticMarkup(<WaitlistOfferView view={view()} />);
    const text = textOf(html);
    expect(text).toContain('It is not a confirmed booking and you will not be charged now.');
    expect(text).toContain('$1,325.00');
    expect(text).toContain('$1,000.00');
    expect(text).toMatch(/holding the place until 19 November 2026/);
    expect(text).toMatch(/7:23\s?pm/i);
    expect(html).not.toMatch(/<dl>\s*<dt>/);
    expect(html).toContain('Accept the offer');
    expect(html).toContain('Decline the offer');
    expect(text).not.toMatch(/guaranteed|official|confirmed place/i);
  });

  it('an offer with no price still lets the person decide', () => {
    const html = renderToStaticMarkup(<WaitlistOfferView view={view({ price: null })} />);
    expect(html).toContain('Accept the offer');
    expect(textOf(html)).not.toContain('Price today');
  });

  it('a waiting entry can only be left; ended entries have no buttons; a converted one links to its request', () => {
    const waiting = renderToStaticMarkup(<WaitlistOfferView view={view({ status: 'waiting', offerExpiresAt: null, price: null })} />);
    expect(waiting).toContain('Leave the waiting list');
    expect(waiting).not.toContain('Accept the offer');
    for (const status of ['expired', 'withdrawn'] as const) {
      const html = renderToStaticMarkup(<WaitlistOfferView view={view({ status, offerExpiresAt: null, price: null })} />);
      expect(html).not.toContain('<button');
    }
    const converted = renderToStaticMarkup(<WaitlistOfferView view={view({ status: 'converted', bookingReference: 'MT-4YRAQQ', offerExpiresAt: null, price: null })} />);
    expect(converted).toContain('/trips/requests/MT-4YRAQQ');
  });

  it('joining a full package says waiting list, nothing charged, and no place held yet', () => {
    const joined = { outcome: 'waitlisted' as const, status: 'waiting', reason: 'sold_out' as const, travellers: 2, package: { name: { 'en-AU': 'Race weekend' } } };
    const text = textOf(renderToStaticMarkup(<WaitlistConfirmation joined={joined} />));
    expect(text).toContain('You are on the waiting list for this trip: this is not a booking request');
    expect(text).toContain('we are not holding any places for you yet');
    expect(text).toContain('we will email you an offer');
    // Where-you-live waiting keeps its own wording.
    expect(textOf(renderToStaticMarkup(<WaitlistConfirmation joined={{ ...joined, reason: 'non_resident' }} />))).toContain('We do not yet take bookings from where you live');
  });

  it('the new pages are in the route tables', () => {
    expect(publicRoutes.map((r) => r.path)).toContain('/waitlist/[id]');
    expect(adminRoutes.map((r) => r.path)).toContain('/admin/waitlist');
  });
});
