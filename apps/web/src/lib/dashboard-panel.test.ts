import { DASHBOARD_PERMISSIONS } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { SECTION_ORDER, bookingPath, editionPath, formatInstant, racePath, tripLine } from './dashboard-panel';

describe('start page helpers', () => {
  it('orders every section the API can send, once', () => {
    expect([...SECTION_ORDER].sort()).toEqual(Object.keys(DASHBOARD_PERMISSIONS).sort());
  });

  it('formats instants in Brisbane time and builds panel paths', () => {
    expect(formatInstant('2026-11-13T04:30:00.000Z')).toMatch(/13 Nov 2026,? 2:30\s?pm/);
    expect(tripLine('Fremantle Run', 2027)).toBe('Fremantle Run 2027');
    expect([bookingPath('b'), editionPath('e'), racePath('r')]).toEqual(['/admin/bookings/b', '/admin/editions/e', '/admin/races/r']);
  });
});
