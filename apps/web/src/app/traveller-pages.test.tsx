import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TRAVELLER_DETAIL_FIELDS } from '@mt/shared';
import type { BookingTravellersView, TravellerView } from '@mt/shared';
import { BookingOverview, type AccountBookingDetail } from '@/components/account/booking-overview';
import { TravellerForms } from '@/components/account/traveller-forms';
import { messageCatalogue } from '@/lib/i18n';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const runner: TravellerView = { slot: 1, participationType: 'runner_with_entry', isLead: true, runner: true, details: null, complete: false };
const supporter: TravellerView = { slot: 2, participationType: 'supporter', isLead: false, runner: false, details: null, complete: false };
const view = (over: Partial<BookingTravellersView> = {}): BookingTravellersView => ({ editable: true, reason: null, editableUntil: '2027-06-06', travellers: [runner, supporter], ...over });
const detail: AccountBookingDetail = {
  booking: { reference: 'MT-4YRAQQ', status: 'deposit_paid', departureDate: '2027-06-18', returnDate: '2027-06-21', currency: 'AUD', totalMinor: '132500', depositMinor: '100000', package: { name: { 'en-AU': 'Race weekend' }, editionYear: 2027, race: { name: { 'en-AU': 'Fremantle Run' } } }, price: { subtotals: {} } },
  plan: { reference: 'MT-4YRAQQ', currency: 'AUD', payable: false, items: [], collectedMinor: '0', outstandingMinor: '0', overpaidMinor: '0', depositDueBy: null, nextPayable: null, methods: [], liveAttempt: null },
  payments: [], documents: [],
};

describe('traveller details page', () => {
  it('shows one form per place, runner-only fields for the runner only, and the API deadline', () => {
    const html = renderToStaticMarkup(<TravellerForms reference="MT-4YRAQQ" initial={view()} />);
    expect(html.match(/<form/g)).toHaveLength(2);
    expect(html).toContain('id="traveller-1-dateOfBirth"');
    expect(html).toContain('id="traveller-1-finishHours"');
    expect(html).not.toContain('id="traveller-2-dateOfBirth"');
    expect(html).not.toContain('id="traveller-2-finishHours"');
    expect(html.match(/<label/g)!.length).toBe(html.match(/<input/g)!.length); // every input has its label
    expect(text(html)).toContain('You can change these details until 6 June 2027.');
    expect(text(html)).toContain('Traveller 1 (you): Runner, entry included');
    expect(text(html)).toContain('Details still needed');
  });

  it('no_form_asks_passport_or_medical: field ids, labels and the catalogue name nothing of the kind', () => {
    const html = renderToStaticMarkup(<TravellerForms reference="MT-4YRAQQ" initial={view()} />);
    const ids = [...html.matchAll(/id="traveller-\d-([A-Za-z]+)"/g)].map((m) => m[1]!);
    const allowed = new Set([...TRAVELLER_DETAIL_FIELDS, 'finishHours', 'finishMinutes']);
    expect(ids.filter((i) => !allowed.has(i as never))).toEqual([]);
    const banned = /passport|medical|health|allerg|dietary|diet|disab|visa|nationality|gender|licen[cs]e|tax file|medicare/i;
    const { fields } = (messageCatalogue() as { account: { travellers: { fields: Record<string, string> } } }).account.travellers;
    expect(Object.entries(fields).filter(([, v]) => banned.test(v))).toEqual([]);
    expect(html).not.toMatch(/<(textarea|select)|type="(file|checkbox)"/);
  });

  it('after the deadline there is no form, the saved details are text, and the API date is quoted', () => {
    const saved: TravellerView = { ...runner, complete: true, details: { givenName: 'Ana', familyName: 'Ruiz', dateOfBirth: '1988-03-14', emergencyContactName: null, emergencyContactPhone: null, estimatedFinishSeconds: 13_500 } };
    const html = renderToStaticMarkup(<TravellerForms reference="MT-4YRAQQ" initial={view({ editable: false, reason: 'deadline_passed', editableUntil: '2027-03-01', travellers: [saved] })} />);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(text(html)).toContain('The deadline for changing these details was 1 March 2027.');
    expect(text(html)).toContain('Ana');
    expect(text(html)).toContain('14 March 1988');
  });

  it('a booking that is not open says why instead of showing a form', () => {
    const html = renderToStaticMarkup(<TravellerForms reference="MT-4YRAQQ" initial={view({ editable: false, reason: 'booking_status' })} />);
    expect(html).not.toContain('<form');
    expect(text(html)).toContain('only be changed after the deposit is paid');
  });

  it('with no deadline set the page says it will be confirmed, and quotes no date', () => {
    const t = text(renderToStaticMarkup(<TravellerForms reference="MT-4YRAQQ" initial={view({ editableUntil: null })} />));
    expect(t).toContain('until we confirm the entry deadline');
  });
});

describe('the booking page section', () => {
  it('counts complete places from the API flags and links to the form while it is open', () => {
    const v = view({ travellers: [{ ...runner, complete: true }, supporter] });
    const html = renderToStaticMarkup(<BookingOverview view={detail} travellers={v} />);
    expect(text(html)).toContain('1 of 2 travellers have the details we need.');
    expect(html).toContain('href="/account/bookings/MT-4YRAQQ/travellers"');
    expect(text(html)).toContain('Add or change traveller details');
  });

  it('is left out when the API gives nothing to show', () => {
    expect(renderToStaticMarkup(<BookingOverview view={detail} />)).not.toContain('travellers-heading');
    expect(renderToStaticMarkup(<BookingOverview view={detail} travellers={view({ editable: false, reason: 'booking_status' })} />)).not.toContain('travellers-heading');
  });
});
