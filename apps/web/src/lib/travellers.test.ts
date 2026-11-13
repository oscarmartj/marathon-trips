import { TRAVELLER_DETAIL_FIELDS } from '@mt/shared';
import type { BookingTravellersView, TravellerView } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { messageCatalogue } from './i18n';
import { emptyForm, formFrom, progress, saveErrorKey, showTravellerSection, toDetailsBody, travellerHref, travellerPath } from './travellers';

const form = (over: Partial<ReturnType<typeof emptyForm>> = {}) => ({ ...emptyForm(), givenName: 'Ana', familyName: 'Ruiz', ...over });
const traveller = (over: Partial<TravellerView> = {}): TravellerView => ({ slot: 1, participationType: 'runner_with_entry', isLead: true, runner: true, details: null, complete: false, ...over });
const view = (over: Partial<BookingTravellersView> = {}): BookingTravellersView => ({ editable: true, reason: null, editableUntil: '2027-06-06', travellers: [traveller()], ...over });

describe('toDetailsBody', () => {
  it('sends only the detail keys, trimmed, with the finish time in seconds', () => {
    const r = toDetailsBody(form({ givenName: ' Ana ', dateOfBirth: '1988-03-14', emergencyContactName: 'Bo Chen', emergencyContactPhone: '0400 123 456', finishHours: '3', finishMinutes: '45' }), true);
    expect(r).toEqual({ ok: true, body: { givenName: 'Ana', familyName: 'Ruiz', dateOfBirth: '1988-03-14', emergencyContactName: 'Bo Chen', emergencyContactPhone: '0400 123 456', estimatedFinishSeconds: 13_500 } });
    if (r.ok) for (const k of Object.keys(r.body)) expect(TRAVELLER_DETAIL_FIELDS as readonly string[]).toContain(k);
  });

  it('leaves out what was not typed', () => {
    expect(toDetailsBody(form(), true)).toEqual({ ok: true, body: { givenName: 'Ana', familyName: 'Ruiz' } });
  });

  it('never sends the runner-only fields for a supporter', () => {
    const r = toDetailsBody(form({ dateOfBirth: '1988-03-14', finishHours: '3', finishMinutes: '10' }), false);
    expect(r).toEqual({ ok: true, body: { givenName: 'Ana', familyName: 'Ruiz' } });
  });

  it.each([
    ['empty given name', { givenName: ' ' }, 'givenName'], ['digits in family name', { familyName: 'Ruiz2' }, 'familyName'],
    ['impossible date', { dateOfBirth: '1990-02-30' }, 'dateOfBirth'], ['minutes over 59', { finishHours: '3', finishMinutes: '75' }, 'estimatedFinish'],
    ['finish under ten minutes', { finishHours: '0', finishMinutes: '5' }, 'estimatedFinish'], ['finish text', { finishHours: 'x', finishMinutes: '5' }, 'estimatedFinish'],
    ['emergency name alone', { emergencyContactName: 'Bo' }, 'emergencyContactPhone'], ['emergency phone alone', { emergencyContactPhone: '0400123456' }, 'emergencyContactPhone'],
    ['short phone', { emergencyContactName: 'Bo', emergencyContactPhone: '123' }, 'emergencyContactPhone'],
  ])('refuses %s without calling the API', (_label, over, field) => {
    const r = toDetailsBody(form(over), true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain(field);
  });
});

describe('form and view helpers', () => {
  it('fills the form from saved details, finish time as hours and minutes', () => {
    const f = formFrom({ givenName: 'Ana', familyName: 'Ruiz', dateOfBirth: '1988-03-14', emergencyContactName: null, emergencyContactPhone: null, estimatedFinishSeconds: 13_500 });
    expect(f).toMatchObject({ givenName: 'Ana', dateOfBirth: '1988-03-14', emergencyContactName: '', finishHours: '3', finishMinutes: '45' });
    expect(formFrom(null)).toEqual(emptyForm());
  });

  it('counts complete places from the API flags and nothing else', () => {
    expect(progress(view({ travellers: [traveller({ complete: true }), traveller({ slot: 2, complete: false }), traveller({ slot: 3, complete: true })] }))).toEqual({ done: 2, total: 3 });
  });

  it('shows the booking page section when a form can be used or something is saved, and otherwise not', () => {
    expect(showTravellerSection(null)).toBe(false);
    expect(showTravellerSection(view())).toBe(true);
    expect(showTravellerSection(view({ editable: false, reason: 'booking_status' }))).toBe(false);
    expect(showTravellerSection(view({ editable: false, reason: 'deadline_passed', travellers: [traveller({ details: { givenName: 'Ana', familyName: 'Ruiz', dateOfBirth: null, emergencyContactName: null, emergencyContactPhone: null, estimatedFinishSeconds: null } })] }))).toBe(true);
  });

  it.each([
    [409, 'travellers_not_editable', 'notEditable'], [404, 'not_found', 'notFound'], [401, 'unauthenticated', 'notFound'], [422, 'invalid_date_of_birth', 'dateOfBirth'],
    [422, 'validation_failed', 'rejected'], [429, undefined, 'tooMany'], [500, undefined, 'generic'],
  ])('maps %s %s to %s, and every key has copy', (status, code, key) => {
    expect(saveErrorKey(status, code)).toBe(key);
    expect(Object.keys((messageCatalogue() as { account: { travellers: { errors: object } } }).account.travellers.errors)).toContain(key);
  });

  it('builds paths only for well-formed references', () => {
    expect(travellerHref('MT-4YRAQQ')).toBe('/account/bookings/MT-4YRAQQ/travellers');
    expect(travellerHref('../x')).toBeNull();
    expect(travellerPath('MT-4YRAQQ', 2)).toBe('/account/bookings/MT-4YRAQQ/travellers/2');
  });
});
