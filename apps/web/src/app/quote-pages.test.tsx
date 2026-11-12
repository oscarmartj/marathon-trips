import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuoteDetailView, type QuoteView } from '@/components/booking/quote-view';
import { adminRoutes, publicRoutes } from '@/lib/routes';

const view = (over: Partial<QuoteView> = {}): QuoteView => ({
  reference: 'QT-4YRAQQ', status: 'sent', acceptable: true, expiresAt: '2026-11-19T09:23:33.035Z', departureDate: '2027-06-18', returnDate: '2027-06-21', balanceDueDate: '2027-04-18',
  currency: 'AUD', totalMinor: '132500', depositMinor: '100000', bookingReference: null, package: { name: { 'en-AU': 'Race weekend' } },
  price: { subtotals: { accommodation: '90000', participation: '42500', extras: '0' }, surchargesMinor: '0', discountsMinor: '0' }, ...over,
});
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('quote page', () => {
  it('quote_page_says_not_yet_a_booking: an open quote shows the API price, the stand-until date and an accept button, and claims no confirmed booking', () => {
    const html = renderToStaticMarkup(<QuoteDetailView view={view()} />);
    const text = textOf(html);
    expect(text).toContain('It is not a confirmed booking yet.');
    expect(text).toContain('You will not be charged now.');
    expect(text).toContain('$1,325.00');
    expect(text).toContain('$900.00');
    expect(text).not.toMatch(/guaranteed|official/i);
    expect(html).toContain('Accept this quote');
  });

  it('a quote that cannot be accepted has no accept button and says why', () => {
    for (const [status, words] of [['expired', 'has expired'], ['withdrawn', 'withdrawn'], ['accepted', 'accepted this quote']] as const) {
      const html = renderToStaticMarkup(<QuoteDetailView view={view({ status, acceptable: false })} />);
      expect(html).not.toContain('Accept this quote');
      expect(textOf(html)).toContain(words);
    }
  });

  it('an accepted quote links to its booking', () => {
    const html = renderToStaticMarkup(<QuoteDetailView view={view({ status: 'accepted', acceptable: false, bookingReference: 'MT-4YRAQQ' })} />);
    expect(html).toContain('/trips/requests/MT-4YRAQQ');
  });

  it('the new pages are in the route tables', () => {
    expect(publicRoutes.map((r) => r.path)).toContain('/quotes/[reference]');
    expect(adminRoutes.map((r) => r.path)).toEqual(expect.arrayContaining(['/admin/bookings/[id]', '/admin/customers/[id]', '/admin/quotes', '/admin/quotes/[id]']));
  });
});
