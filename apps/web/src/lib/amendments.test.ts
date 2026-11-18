import { describe, expect, it } from 'vitest';
import { amendmentErrorKey, customerBody, formFrom, staffBody } from './amendments';
import type { ConfigurationView } from './amendments';
import { t } from './i18n';
import { changeFormProps } from './account-changes';

const D = '0192f000-0000-7000-8000-00000000000d';
const R = '0192f000-0000-7000-8000-00000000000a';
const Q = '0192f000-0000-7000-8000-00000000000b';
const X = '0192f000-0000-7000-8000-00000000000c';
const conf: ConfigurationView = {
  rooms: [{ roomOptionId: R, occupancy: 2, travellers: [{ slot: 1, participationType: 'runner_with_entry', raceDistanceId: D }, { slot: 3, participationType: 'supporter', raceDistanceId: null }] }],
  extraNightsBefore: 0, extraNightsAfter: 1, extras: [{ extraId: X, travellerSlots: [3], quantity: 1 }],
};
const MONEY = /minor|amount|total|price|deposit|balance/i;
const keysOf = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v as object).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);

describe('change request bodies (task 6.3)', () => {
  it('request_body_has_no_money_keys: the staff and customer bodies carry choices only', () => {
    const form = formFrom(conf, 2, new Set([X]));
    const body = staffBody(form);
    expect(keysOf(body).filter((k) => MONEY.test(k))).toEqual([]);
    const c = customerBody({ version: 2, extraNightsBefore: 1, extraNightsAfter: 0, perPerson: { [X]: [3, 1] }, perBooking: {} });
    expect(keysOf(c).filter((k) => MONEY.test(k))).toEqual([]);
    expect(c.extras).toEqual([{ extraId: X, travellerSlots: [1, 3] }]);
  });

  it('staff bodies keep places by number and give per-person extras the positions of the new rooms', () => {
    const form = formFrom(conf, 2, new Set([X]));
    expect(staffBody(form)).toEqual({
      expectedSnapshotVersion: 2, rooms: [{ roomOptionId: R, travellers: [{ keepSlot: 1 }, { keepSlot: 3 }] }], extraNightsBefore: 0, extraNightsAfter: 1,
      extras: [{ extraId: X, travellerSlots: [2] }], reasonCode: 'customer_request',
    });
    // Place 1 is replaced by a supporter and moved to a new quad with a new runner first: positions follow the new order.
    form.rooms[0]!.travellers[0] = { kind: 'new', participationType: 'supporter', raceDistanceId: D, replacesSlot: 1 };
    form.rooms.unshift({ roomOptionId: Q, travellers: [{ kind: 'new', participationType: 'runner_with_entry', raceDistanceId: D, replacesSlot: null }] });
    const b = staffBody(form);
    expect(b.rooms[1]!.travellers[0]).toEqual({ participationType: 'supporter', replacesSlot: 1 });
    expect(b.rooms[0]!.travellers[0]).toEqual({ participationType: 'runner_with_entry', raceDistanceId: D });
    expect(b.extras).toEqual([{ extraId: X, travellerSlots: [3] }]);
  });

  it('every error code has a message and unknown ones read as generic', () => {
    for (const c of ['amendment_price_basis_drifted', 'amendment_needs_staff', 'inventory_unavailable', 'terms_not_accepted', 'nonsense', undefined]) expect(t(amendmentErrorKey(c))).toMatch(/\w/);
    expect(amendmentErrorKey('nonsense')).toBe('amendments.errors.generic');
  });

  it('the change page offers optional extras only, with the booking place numbers', () => {
    const props = changeFormProps(
      { booking: { reference: 'MT-4YRAQQ', status: 'confirmed', departureDate: '2027-06-18', returnDate: '2027-06-22', currency: 'AUD', totalMinor: '1', depositMinor: '1', currentSnapshotVersion: 2, package: { name: {}, editionYear: 2027, race: { name: {} } }, price: { configuration: conf } }, plan: {} as never, payments: [], documents: [] },
      { maxExtraNightsBefore: 2, maxExtraNightsAfter: 2, extras: [{ id: X, kind: 'excursion', name: { 'en-AU': 'City tour' }, description: {}, pricingUnit: 'per_person', availableTo: 'all', mandatory: false, maxPerBooking: null, availability: 'available' as never }] },
    )!;
    expect(props.places).toEqual([{ slot: 1 }, { slot: 3 }]);
    expect(props.current.perPerson).toEqual({ [X]: [3] });
    expect(props.nights).toEqual({ before: 0, after: 1, maxBefore: 2, maxAfter: 2 });
  });
});
