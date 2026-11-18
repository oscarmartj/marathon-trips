import { describe, expect, it } from 'vitest';
import { createReportSchema, reportDefinitionSchema, reportScheduleSchema } from '@mt/shared';
import { SCHEDULE_WINDOW_MS, addDays, latestOccurrence, resolveRange, todayInBusinessZone } from '../../../src/modules/reports/dates';
import { ratePct } from '../../../src/modules/reports/engine';
import { formatReportText } from '../../../src/modules/reports/emails';

const range = { kind: 'last_days', days: 30 } as const;
const funnel = (over: Record<string, unknown> = {}) => ({ entity: 'funnel', columns: ['views', 'requests'], groupBy: 'race', range, ...over });
const bookings = (over: Record<string, unknown> = {}) => ({ entity: 'bookings', columns: ['bookings', 'paid'], groupBy: 'month', range, ...over });
const uuid = '0192f0a0-0000-7000-8000-000000000001';

describe('report definition schema', () => {
  it.each([
    ['funnel with every grouping', funnel({ groupBy: 'none' })],
    ['funnel by month', funnel({ groupBy: 'month' })],
    ['bookings by package', bookings({ groupBy: 'package' })],
    ['bookings by channel and a race filter', bookings({ groupBy: 'channel', raceIds: [uuid] })],
    ['dates range', funnel({ range: { kind: 'dates', from: '2027-01-01', to: '2027-12-31' } })],
  ])('accepts %s', (_n, def) => expect(reportDefinitionSchema.safeParse(def).success).toBe(true));

  it.each([
    ['a column of the other entity', funnel({ columns: ['views', 'declined'] })],
    ['a made-up column', funnel({ columns: ['email'] })],
    ['a duplicate column', funnel({ columns: ['views', 'views'] })],
    ['no columns', funnel({ columns: [] })],
    ['more than ten columns', bookings({ columns: Array.from({ length: 11 }, (_, i) => `c${i}`) })],
    ['a grouping of the other entity', funnel({ groupBy: 'package' })],
    ['a made-up grouping', bookings({ groupBy: 'customer' })],
    ['an unknown entity', funnel({ entity: 'customers' })],
    ['an unknown field', funnel({ sql: 'select 1' })],
    ['more than fifty races', funnel({ raceIds: Array.from({ length: 51 }, () => uuid) })],
    ['a race id that is not a uuid', funnel({ raceIds: ['x'] })],
    ['zero days', funnel({ range: { kind: 'last_days', days: 0 } })],
    ['367 days', funnel({ range: { kind: 'last_days', days: 367 } })],
    ['dates in the wrong order', funnel({ range: { kind: 'dates', from: '2027-02-01', to: '2027-01-01' } })],
    ['a range over a year', funnel({ range: { kind: 'dates', from: '2025-01-01', to: '2027-01-01' } })],
    ['a date that does not exist', funnel({ range: { kind: 'dates', from: '2027-02-30', to: '2027-03-01' } })],
  ])('refuses %s', (_n, def) => expect(reportDefinitionSchema.safeParse(def).success).toBe(false));
});

describe('report schedule schema', () => {
  it.each([
    [{ frequency: 'weekly', weekday: 1, time: '08:00' }, true],
    [{ frequency: 'weekly', weekday: 7, time: '23:55' }, true],
    [{ frequency: 'monthly', dayOfMonth: 28, time: '00:00' }, true],
    [{ frequency: 'weekly', time: '08:00' }, false],
    [{ frequency: 'weekly', weekday: 8, time: '08:00' }, false],
    [{ frequency: 'weekly', weekday: 1, dayOfMonth: 3, time: '08:00' }, false],
    [{ frequency: 'monthly', weekday: 1, time: '08:00' }, false],
    [{ frequency: 'monthly', dayOfMonth: 29, time: '08:00' }, false],
    [{ frequency: 'monthly', dayOfMonth: 0, time: '08:00' }, false],
    [{ frequency: 'daily', time: '08:00' }, false],
    [{ frequency: 'weekly', weekday: 1, time: '08:01' }, false],
    [{ frequency: 'weekly', weekday: 1, time: '24:00' }, false],
    [{ frequency: 'weekly', weekday: 1, time: '8:00' }, false],
  ])('%j -> %s', (s, ok) => expect(reportScheduleSchema.safeParse(s).success).toBe(ok));

  it('create refuses duplicate recipients and more than twenty', () => {
    const base = { name: 'x', definition: funnel() };
    expect(createReportSchema.safeParse({ ...base, recipientUserIds: [uuid, uuid] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => `0192f0a0-0000-7000-8000-${String(i).padStart(12, '0')}`);
    expect(createReportSchema.safeParse({ ...base, recipientUserIds: many }).success).toBe(false);
    expect(createReportSchema.safeParse({ ...base, name: '  ' }).success).toBe(false);
    expect(createReportSchema.safeParse({ ...base, recipientUserIds: [uuid], extra: 1 }).success).toBe(false);
  });
});

describe('latestOccurrence (Brisbane is UTC+10 all year)', () => {
  const weekly = (weekday: number, time: string) => reportScheduleSchema.parse({ frequency: 'weekly', weekday, time });
  const monthly = (dayOfMonth: number, time: string) => reportScheduleSchema.parse({ frequency: 'monthly', dayOfMonth, time });
  // 2027-03-03 is a Wednesday. 08:00 Brisbane = 22:00 UTC the day before.
  it.each([
    ['same day, after the time', weekly(3, '08:00'), '2027-03-03T00:00:00Z', '2027-03-02T22:00:00.000Z'],
    ['same day, before the time: a week earlier', weekly(3, '08:00'), '2027-03-02T21:59:00Z', '2027-02-23T22:00:00.000Z'],
    ['exactly on the time', weekly(3, '08:00'), '2027-03-02T22:00:00Z', '2027-03-02T22:00:00.000Z'],
    ['a later weekday of the previous week', weekly(5, '09:30'), '2027-03-03T05:00:00Z', '2027-02-25T23:30:00.000Z'],
    ['sunday', weekly(7, '00:00'), '2027-03-03T05:00:00Z', '2027-02-27T14:00:00.000Z'],
    ['monthly, later in the month', monthly(1, '08:00'), '2027-03-03T05:00:00Z', '2027-02-28T22:00:00.000Z'],
    ['monthly, before the day: last month', monthly(15, '08:00'), '2027-03-03T05:00:00Z', '2027-02-14T22:00:00.000Z'],
    ['monthly across the new year', monthly(28, '08:00'), '2027-01-05T05:00:00Z', '2026-12-27T22:00:00.000Z'],
    ['brisbane date already tomorrow in UTC, before the time', weekly(4, '06:00'), '2027-03-03T15:00:00Z', '2027-02-24T20:00:00.000Z'],
    ['brisbane date already tomorrow in UTC, after the time', weekly(4, '06:00'), '2027-03-03T21:00:00Z', '2027-03-03T20:00:00.000Z'],
  ])('%s', (_n, schedule, now, expected) => expect(latestOccurrence(schedule, new Date(now)).toISOString()).toBe(expected));

  it('the window is six hours', () => expect(SCHEDULE_WINDOW_MS).toBe(6 * 3_600_000));
});

describe('ranges and rates', () => {
  it('last_days ends today in Brisbane and includes it', () => {
    // 20:00 UTC on 2 March is 06:00 on 3 March in Brisbane.
    const now = new Date('2027-03-02T20:00:00Z');
    expect(todayInBusinessZone(now)).toBe('2027-03-03');
    expect(resolveRange({ kind: 'last_days', days: 1 }, now)).toEqual({ from: '2027-03-03', to: '2027-03-03' });
    expect(resolveRange({ kind: 'last_days', days: 7 }, now)).toEqual({ from: '2027-02-25', to: '2027-03-03' });
    expect(resolveRange({ kind: 'dates', from: '2027-01-01', to: '2027-01-31' }, now)).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });

  // Scheduled sends cover whole days that ended before the scheduled time, and the next one starts where this one ended.
  it.each([
    ['weekly Monday 08:00, 7 days: Monday to Sunday', '2027-02-28T22:00:00Z', 7, '2027-02-22', '2027-02-28'], // Monday 1 March 08:00 Brisbane
    ['the next week starts the day after', '2027-03-07T22:00:00Z', 7, '2027-03-01', '2027-03-07'],
    ['one day: yesterday only', '2027-03-01T22:00:00Z', 1, '2027-03-01', '2027-03-01'],
    ['sent at 00:00 Brisbane: the day that just ended', '2027-02-28T14:00:00Z', 7, '2027-02-22', '2027-02-28'], // Monday 1 March 00:00
    ['sent at 23:59 Brisbane: still before that day', '2027-03-01T13:59:00Z', 7, '2027-02-22', '2027-02-28'],
    ['sent one minute before midnight on the Sunday: the day before', '2027-02-28T13:59:00Z', 7, '2027-02-21', '2027-02-27'],
    ['monthly on the 1st over a month end, 30 days', '2027-02-28T22:00:00Z', 30, '2027-01-30', '2027-02-28'],
    ['across the new year', '2026-12-31T22:00:00Z', 7, '2026-12-25', '2026-12-31'], // 1 January 2027 08:00
    ['leap day', '2028-02-29T22:00:00Z', 2, '2028-02-28', '2028-02-29'], // 1 March 2028 08:00
  ])('a scheduled range: %s', (_n, scheduledFor, days, from, to) => {
    expect(resolveRange({ kind: 'last_days', days }, new Date(scheduledFor), { completeDaysOnly: true })).toEqual({ from, to });
  });

  it('consecutive weekly sends leave no day out and count none twice', () => {
    const range = { kind: 'last_days', days: 7 } as const;
    let previousTo = '';
    for (let week = 0; week < 60; week++) {
      const at = new Date(Date.parse('2027-01-03T22:00:00Z') + week * 7 * 86_400_000); // Mondays 08:00 in Brisbane
      const { from, to } = resolveRange(range, at, { completeDaysOnly: true });
      if (previousTo) expect(from).toBe(addDays(previousTo, 1));
      previousTo = to;
    }
  });

  it('a dates range and an on-screen range are not changed by the option', () => {
    const at = new Date('2027-03-01T22:00:00Z');
    expect(resolveRange({ kind: 'dates', from: '2027-01-01', to: '2027-01-31' }, at, { completeDaysOnly: true })).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    expect(resolveRange({ kind: 'last_days', days: 7 }, at)).toEqual({ from: '2027-02-24', to: '2027-03-02' });
  });

  it.each([
    [1, 3, 33.3], [2, 3, 66.7], [3, 3, 100], [0, 5, 0], [5, 0, null], [0, 0, null], [1, 8, 12.5], [1, 6, 16.7],
  ])('ratePct(%i, %i) = %s', (part, whole, expected) => expect(ratePct(part, whole)).toBe(expected));
});

describe('report email text', () => {
  const result = { columns: ['views', 'request_rate_pct'], groupBy: 'race', from: '2027-01-01', to: '2027-01-31', truncated: false, rows: [{ key: 'a', label: 'Polar Circle Marathon', values: { views: 120, request_rate_pct: null } }, { key: 'b', label: 'B', values: { views: 3, request_rate_pct: 33.3 } }] };
  it('prints a table with counts, a dash for no rate, and the link', () => {
    const text = formatReportText('Weekly funnel', result, 'https://example.test/admin/reports');
    expect(text).toContain('From 2027-01-01 to 2027-01-31');
    expect(text).toContain('Polar Circle Marathon  120    -');
    expect(text).toContain('https://example.test/admin/reports');
  });
  it('says so when there is no data and when rows were cut', () => {
    expect(formatReportText('x', { ...result, rows: [] }, 'l')).toContain('No data in this period.');
    const many = { ...result, rows: Array.from({ length: 101 }, (_, i) => ({ key: String(i), label: `R${i}`, values: { views: i, request_rate_pct: null } })) };
    const text = formatReportText('x', many, 'l');
    expect(text).toContain('Showing the first 100 rows');
    expect(text).not.toContain('R100');
  });
});
