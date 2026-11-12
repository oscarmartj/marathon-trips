import type { PriceBreakdownJson } from '@mt/shared';
import { DIST_MARATHON, EXTRA_TOUR, ROOM_TWIN } from './catalogue-fixtures';

/**
 * A breakdown as the API sends it. The figures are the API's, written out by hand: a test that wants a different
 * total changes the string. Nothing in the web app can derive one from another, which is the point of the tests.
 */
export const breakdown = (over: Partial<PriceBreakdownJson> = {}): PriceBreakdownJson => ({
  currency: 'AUD', priceVersionId: '99999999-9999-4999-8999-999999999999', engineVersion: 'test', computedAt: '2027-01-01T00:00:00.000Z',
  configuration: {
    packageId: '88888888-8888-4888-8888-888888888888',
    rooms: [{ roomOptionId: ROOM_TWIN, occupancy: 1, travellers: [{ slot: 1, participationType: 'runner_with_entry', raceDistanceId: DIST_MARATHON }] }],
    extraNightsBefore: 0, extraNightsAfter: 0, extras: [{ extraId: EXTRA_TOUR, travellerSlots: [1], quantity: 1 }],
  },
  departureDate: '2027-04-29', returnDate: '2027-05-03',
  lines: [
    { key: 'room:1', component: 'accommodation', kind: 'room', direction: 'charge', travellerSlot: 1, refId: ROOM_TWIN, unitAmountMinor: '120000', quantity: 1, amountMinor: '120000', cappedFromMinor: null, effect: null },
    { key: 'participation:1', component: 'participation', kind: 'participation', direction: 'charge', travellerSlot: 1, refId: DIST_MARATHON, unitAmountMinor: '45000', quantity: 1, amountMinor: '45000', cappedFromMinor: null, effect: null },
    { key: 'extra:t:1', component: 'extras', kind: 'extra', direction: 'charge', travellerSlot: 1, refId: EXTRA_TOUR, unitAmountMinor: '9950', quantity: 1, amountMinor: '9950', cappedFromMinor: null, effect: null },
    { key: 'rule:early', component: 'accommodation', kind: 'rule', direction: 'discount', travellerSlot: null, refId: null, unitAmountMinor: '10000', quantity: 1, amountMinor: '10000', cappedFromMinor: null, effect: null },
  ],
  subtotals: { accommodation: '110000', participation: '45000', extras: '9950', subtotal: '164950' },
  surchargesMinor: '0', discountsMinor: '10000', totalMinor: '164950',
  perTraveller: [{ slot: 1, amountMinor: '164950' }], unattributedMinor: '0',
  depositMinor: '50000', balanceMinor: '114950', balanceDueDate: '2027-03-01', fullPaymentDue: false,
  promo: { status: 'none' },
  ...over,
});
