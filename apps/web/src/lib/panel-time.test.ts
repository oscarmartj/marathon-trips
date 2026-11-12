import { describe, expect, it } from 'vitest';
import { formatInstant, isoToLocal, localToIso, sameInstant } from './panel-time';

describe('panel time', () => {
  it.each([
    ['2027-03-01T09:30', 600, '2027-02-28T23:30:00.000Z'], // Brisbane, UTC+10
    ['2027-03-01T09:30', 0, '2027-03-01T09:30:00.000Z'],
    ['2027-03-01T00:00', -300, '2027-03-01T05:00:00.000Z'],
    ['2028-02-29T12:00', 570, '2028-02-29T02:30:00.000Z'], // leap day, UTC+9:30
  ])('local_to_iso %s at %i', (local, offset, iso) => {
    expect(localToIso(local, offset)).toBe(iso);
  });
  it.each(['', '2027-03-01', '2027-02-31T10:00', '2027-13-01T10:00', '2027-03-01T24:00', '2027-03-01T10:60', 'nonsense', '2027-03-01T10:00:00'])('local_to_iso_refuses %j', (text) => {
    expect(localToIso(text, 600)).toBeNull();
  });
  it('round_trips_at_every_offset', () => {
    for (const offset of [-720, -300, 0, 570, 600, 765, 840]) {
      for (const local of ['2027-01-01T00:00', '2027-06-30T23:59', '2028-02-29T12:00']) {
        expect(isoToLocal(localToIso(local, offset), offset)).toBe(local);
      }
    }
  });
  it('iso_to_local_handles_empty_and_nonsense', () => {
    expect(isoToLocal(null, 600)).toBe('');
    expect(isoToLocal('', 600)).toBe('');
    expect(isoToLocal('not a date', 600)).toBe('');
  });
  it('same_instant_ignores_the_way_it_is_written', () => {
    expect(sameInstant('2027-03-01T00:00:00.000Z', '2027-03-01T10:00:00+10:00')).toBe(true);
    expect(sameInstant('2027-03-01T00:00:00.000Z', '2027-03-01T00:00:01.000Z')).toBe(false);
    expect(sameInstant(null, null)).toBe(true);
    expect(sameInstant(null, '2027-03-01T00:00:00.000Z')).toBe(false);
  });
  it('formats_an_instant_with_its_time_zone', () => {
    expect(formatInstant('2027-03-01T00:00:00.000Z', 'Australia/Brisbane')).toMatch(/^1 Mar 2027,? 10:00\s?am (AEST|GMT\+10)$/i);
    expect(formatInstant('2027-03-01T00:00:00.000Z', 'UTC')).toMatch(/12:00\s?am/i);
    expect(formatInstant(null)).toBe('');
    expect(formatInstant('')).toBe('');
  });
});
