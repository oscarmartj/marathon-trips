import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRIP_LIST_KINDS } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { t } from './i18n';
import { guestName, listPath, tripLabel } from './trip-lists-panel';

describe('trip lists panel helpers', () => {
  it('builds the trip line and the paths of each list, with the CSV on request', () => {
    expect(tripLabel({ raceName: 'Test Marathon', year: 2027, packageName: 'Race weekend' })).toBe('Test Marathon 2027 · Race weekend');
    for (const kind of TRIP_LIST_KINDS) {
      expect(listPath('abc', kind)).toBe(`/admin/trip-ops/trips/abc/${kind}`);
      expect(listPath('abc', kind, 'csv')).toBe(`/admin/trip-ops/trips/abc/${kind}?format=csv`);
    }
  });

  it('never lets an id shape the path', () => {
    expect(listPath('a/../b?x=1', 'transfers')).toBe('/admin/trip-ops/trips/a%2F..%2Fb%3Fx%3D1/transfers');
  });

  it('shows a name as stored, redacted included, and says so while it has not been typed', () => {
    expect(guestName({ givenName: 'Ana', familyName: 'Garcia' }, 'pending')).toBe('Ana Garcia');
    expect(guestName({ givenName: '[redacted]', familyName: '[redacted]' }, 'pending')).toBe('[redacted] [redacted]');
    expect(guestName({ givenName: null, familyName: null }, 'pending')).toBe('pending');
  });

  it('has every message the panel asks for, in Australian English', () => {
    const src = readFileSync(join(__dirname, '../components/admin/triplists/trip-lists-panel.tsx'), 'utf8');
    const keys = [...src.matchAll(/t\(\s*[`']([a-zA-Z.]+)[`']/g)].map((m) => m[1]!).filter((k) => k.startsWith('admin.'));
    expect(keys.length).toBeGreaterThan(20);
    const params = { rooms: 1, guests: 2, pending: 0, hotel: 'H', city: 'C', room: 'R', occupancy: 2, passengers: 1, origin: 'A', destination: 'B', day: 1, date: 'D', trip: 'T', count: 1, list: 'L' };
    for (const k of keys) expect(() => t(k, params), k).not.toThrow();
    for (const k of ['check_in', 'check_out', 'race', 'extra']) expect(() => t(`admin.triplists.itemKinds.${k}`)).not.toThrow();
    expect(t('admin.nav.triplists')).toBe('Trip lists');
  });
});
