import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RequestConfirmation, dateInBrisbane, type RequestView } from '@/components/booking/request-confirmation';
import { formatDate } from '@/lib/catalogue-format';

const view = (over: Partial<RequestView> = {}): RequestView => ({
  reference: 'MT-4YRAQQ', status: 'requested', isRequest: true, requestExpiresAt: '2026-11-19T09:23:33.035Z', departureDate: '2027-06-18', returnDate: '2027-06-21',
  balanceDueDate: '2027-04-18', currency: 'AUD', totalMinor: '132500', depositMinor: '100000', package: { name: { 'en-AU': 'Race weekend' } }, ...over,
});

describe('confirmation page', () => {
  it('confirmation_page_says_request_not_booking: the heading and the first notice say it is a request, not a confirmed booking, and nothing was charged', () => {
    const html = renderToStaticMarkup(<RequestConfirmation view={view()} />);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/Request received: this is not a confirmed booking yet/);
    expect(text).toMatch(/It is a request, not a confirmed booking\./);
    expect(text).toMatch(/We have not charged you anything\./);
    expect(text.indexOf('not a confirmed booking')).toBeLessThan(text.indexOf('MT-4YRAQQ'));
    expect(text).not.toMatch(/\bconfirmed\b(?! booking)/i);
    expect(text).toContain('$1,325.00');
    expect(text).toContain('MT-4YRAQQ');
    expect(html).toContain('role="status"');
  });

  it('a request that is no longer open shows its status, not the "received" wording', () => {
    const text = renderToStaticMarkup(<RequestConfirmation view={view({ status: 'declined', isRequest: false })} />);
    expect(text).toContain('We could not offer this trip.');
    expect(text).not.toContain('Request received');
  });

  it('the hold date is the day in Brisbane, not in UTC: 07:30 on the 19th in Brisbane is the 18th in UTC', () => {
    expect(dateInBrisbane('2026-11-18T21:30:00.000Z')).toBe('2026-11-19');
    expect(dateInBrisbane('2026-11-18T13:59:59.000Z')).toBe('2026-11-18');
    const text = renderToStaticMarkup(<RequestConfirmation view={view({ requestExpiresAt: '2026-11-18T21:30:00.000Z' })} />);
    expect(text).toContain(formatDate('2026-11-19'));
    expect(text).not.toContain(formatDate('2026-11-18'));
    expect(text).not.toMatch(/email you/i);
  });
});
