import { describe, expect, it } from 'vitest';
import { TRAVELLER_DETAIL_FIELDS, finishTimeToSeconds, secondsToFinishTime, travellerDetailsSchema } from './travellers';

const ok = { givenName: 'Ana', familyName: 'García-López' };

describe('travellerDetailsSchema', () => {
  it('accepts the minimum and the full set', () => {
    expect(travellerDetailsSchema.safeParse(ok).success).toBe(true);
    expect(travellerDetailsSchema.safeParse({ ...ok, dateOfBirth: '1990-02-28', emergencyContactName: "Sean O'Neil", emergencyContactPhone: '+61 400 123 456', estimatedFinishSeconds: 14_400 }).success).toBe(true);
  });

  it.each([
    ['passportNumber', 'X1234567'], ['nationality', 'AU'], ['gender', 'f'], ['email', 'a@b.co'], ['phone', '0400123456'], ['address', '1 Main St'],
    ['medicalConditions', 'asthma'], ['allergies', 'nuts'], ['dietaryNeeds', 'vegan'], ['notes', 'hello'], ['id', 'x'], ['slot', 1],
  ])('refuses the key %s', (key, value) => {
    expect(travellerDetailsSchema.safeParse({ ...ok, [key]: value }).success).toBe(false);
  });

  it.each([
    ['empty given name', { givenName: '' }], ['spaces only', { givenName: '   ' }], ['digit in name', { familyName: 'Smith2' }], ['symbol in name', { givenName: 'Ana <b>' }],
    ['101 characters', { givenName: 'a'.repeat(101) }], ['name starting with a hyphen', { givenName: '-Ana' }],
    ['30 February', { dateOfBirth: '1990-02-30' }], ['before 1900', { dateOfBirth: '1899-12-31' }], ['not a date', { dateOfBirth: 'soon' }], ['wrong format', { dateOfBirth: '28/02/1990' }],
    ['finish 599', { estimatedFinishSeconds: 599 }], ['finish 259201', { estimatedFinishSeconds: 259_201 }], ['finish fraction', { estimatedFinishSeconds: 14_400.5 }], ['finish string', { estimatedFinishSeconds: '14400' }],
    ['short phone', { emergencyContactName: 'Bo', emergencyContactPhone: '12345' }], ['phone with letters', { emergencyContactName: 'Bo', emergencyContactPhone: '0400 abc 123' }],
    ['phone, no name', { emergencyContactPhone: '0400123456' }], ['name, no phone', { emergencyContactName: 'Bo' }],
  ])('refuses %s', (_label, over) => {
    expect(travellerDetailsSchema.safeParse({ ...ok, ...over }).success).toBe(false);
  });

  it('lists exactly the fields the form may ask for', () => {
    expect([...TRAVELLER_DETAIL_FIELDS]).toEqual(['givenName', 'familyName', 'dateOfBirth', 'emergencyContactName', 'emergencyContactPhone', 'estimatedFinishSeconds']);
    expect(Object.keys(travellerDetailsSchema.def.shape ?? {}).sort()).toEqual([...TRAVELLER_DETAIL_FIELDS].sort());
  });
});

describe('finish time helpers', () => {
  it.each([
    ['', '', null], ['3', '45', 13_500], ['0', '10', 600], ['0', '9', null], ['72', '0', 259_200], ['72', '1', null], ['3', '60', null], ['x', '5', null], ['3', '', 10_800],
  ])('%s h %s min', (h, m, expected) => {
    expect(finishTimeToSeconds(h, m)).toBe(expected);
  });
  it('round trips', () => {
    expect(secondsToFinishTime(13_500)).toEqual({ hours: '3', minutes: '45' });
  });
});
