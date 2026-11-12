import { describe, expect, it } from 'vitest';
import { quoteRequestSchema } from '@mt/shared';
import { builderToSearch, defaultState, eligibleSlots, formatMoney, parseBuilderParams, quoteErrorKey, toQuoteRequest, type BuilderState } from './builder';
import { DIST_HALF, DIST_MARATHON, EXTRA_PASTA, EXTRA_TOUR, EXTRA_TRANSFER, packageDetail, ROOM_SINGLE, ROOM_TWIN } from '@/test/catalogue-fixtures';

const pkg = packageDetail();

describe('formatMoney (formatting only, no arithmetic)', () => {
  it.each([
    ['0', 'AUD', '$0.00'],
    ['5', 'AUD', '$0.05'],
    ['123450', 'AUD', '$1,234.50'],
    ['100000000', 'AUD', '$1,000,000.00'],
    ['999999999999', 'AUD', '$9,999,999,999.99'],
    ['000700', 'AUD', '$7.00'],
  ])('%s %s -> %s', (minor, currency, text) => expect(formatMoney(minor, currency)).toBe(text));

  // The symbol for other currencies depends on the ICU data of the runtime, so these check the digits and the currency, not the glyph.
  it('uses the currency\'s own number of decimals', () => {
    expect(formatMoney('150000', 'JPY')).toMatch(/^(JPY\s|¥)150,000$/);
    expect(formatMoney('12345', 'NZD')).toMatch(/^(NZD\s|NZ\$)123\.45$/);
  });

  it('puts a minus on a discount line and never on zero', () => {
    expect(formatMoney('2500', 'AUD', '-')).toBe('-$25.00');
    expect(formatMoney('0', 'AUD', '-')).toBe('$0.00');
  });

  it('shows nothing for something that is not an amount', () => {
    expect(formatMoney('12.5', 'AUD')).toBe('');
    expect(formatMoney('abc', 'AUD')).toBe('');
  });
});

describe('the URL holds the choices', () => {
  it('starts from the first room that has stock, at its minimum occupancy, with a runner who has an entry', () => {
    const s = defaultState(pkg);
    expect(s.rooms).toEqual([{ roomOptionId: ROOM_TWIN, travellers: [{ type: 'runner_with_entry', distanceId: DIST_MARATHON }] }]);
  });

  it('round-trips rooms, travellers, nights and extras', () => {
    const state: BuilderState = {
      rooms: [{ roomOptionId: ROOM_TWIN, travellers: [{ type: 'runner_with_entry', distanceId: DIST_MARATHON }, { type: 'supporter', distanceId: '' }] }],
      nightsBefore: 1, nightsAfter: 2, extras: { [EXTRA_TOUR]: { slots: [1, 2], quantity: 0 } },
    };
    const sp = Object.fromEntries(new URLSearchParams(builderToSearch(state)).entries());
    expect(parseBuilderParams(pkg, sp)).toEqual(state);
  });

  it('drops what the package does not have and clamps what is out of range', () => {
    const s = parseBuilderParams(pkg, { r: ['nope~supporter', `${ROOM_TWIN}~wizard~supporter~supporter~supporter`], nb: '99', na: 'x', x: [`${EXTRA_TRANSFER}:1`, 'unknown:1'] });
    expect(s.rooms).toHaveLength(1);
    expect(s.rooms[0]!.travellers).toEqual([{ type: 'supporter', distanceId: '' }]);
    expect(s.nightsBefore).toBe(2);
    expect(s.nightsAfter).toBe(0);
    expect(s.extras).toEqual({});
  });

  it('falls back to the default for an empty or broken address', () => {
    expect(parseBuilderParams(pkg, {})).toEqual(defaultState(pkg));
    expect(parseBuilderParams(pkg, { r: 'garbage' })).toEqual(defaultState(pkg));
  });

  it('does not offer a runner-with-entry type if the package has no entries', () => {
    const none = packageDetail({ entries: [] });
    expect(defaultState(none).rooms[0]!.travellers[0]!.type).toBe('runner_own_entry');
  });
});

describe('the quote request is a configuration, never an amount', () => {
  const state: BuilderState = {
    rooms: [{ roomOptionId: ROOM_TWIN, travellers: [{ type: 'runner_with_entry', distanceId: DIST_HALF }, { type: 'supporter', distanceId: '' }] }],
    nightsBefore: 1, nightsAfter: 0,
    extras: { [EXTRA_TOUR]: { slots: [1, 2], quantity: 0 }, [EXTRA_PASTA]: { slots: [1, 2], quantity: 0 }, [EXTRA_TRANSFER]: { slots: [], quantity: 1 } },
  };
  const request = toQuoteRequest(pkg, state);

  it('is accepted by the API schema, which rejects any unknown field', () => {
    expect(quoteRequestSchema.safeParse(request).success).toBe(true);
  });

  it('carries no money, price, total or date key at any depth', () => {
    const keys: string[] = [];
    const walk = (v: unknown) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(request);
    expect(keys.filter((k) => /amount|price|total|minor|deposit|balance|cost|date|discount|rule/i.test(k))).toEqual([]);
  });

  it('sends a distance only for a runner with an entry', () => {
    expect(request.rooms[0]!.travellers).toEqual([{ participationType: 'runner_with_entry', raceDistanceId: DIST_HALF }, { participationType: 'supporter' }]);
  });

  it('leaves out mandatory extras (the API adds them) and slots of travellers who are not eligible', () => {
    expect(request.extras).toEqual([{ extraId: EXTRA_TOUR, travellerSlots: [1, 2] }, { extraId: EXTRA_PASTA, travellerSlots: [1] }]);
    expect(eligibleSlots(pkg.extras.find((x) => x.id === EXTRA_PASTA)!, state)).toEqual([1]);
  });

  it('leaves out an extra nobody takes', () => {
    expect(toQuoteRequest(pkg, { ...state, extras: { [EXTRA_TOUR]: { slots: [], quantity: 0 } } }).extras).toEqual([]);
  });

  it('uses the single room the visitor picked', () => {
    const single = { ...state, rooms: [{ roomOptionId: ROOM_SINGLE, travellers: [{ type: 'supporter' as const, distanceId: '' }] }] };
    expect(toQuoteRequest(pkg, single).rooms[0]!.roomOptionId).toBe(ROOM_SINGLE);
  });
});

describe('quoteErrorKey', () => {
  it.each([[0, 'network'], [404, 'notOpen'], [409, 'notReady'], [422, 'unavailable'], [429, 'tooMany'], [500, 'generic'], [503, 'generic']])('%i -> %s', (status, key) =>
    expect(quoteErrorKey(status)).toBe(`builder.errors.${key}`));
});
