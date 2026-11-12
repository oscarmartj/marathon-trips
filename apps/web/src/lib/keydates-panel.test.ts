import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALENDAR_ITEM_KINDS, KEY_DATE_KINDS } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { catalogueError } from '@/components/admin/catalogue/kit';
import { t } from './i18n';
import { addableKinds, calendarPath, createBody, isStored, tripLabel } from './keydates-panel';
import type { CalendarItem } from './keydates-panel';

const item = (over: Partial<CalendarItem> = {}): CalendarItem => ({ key: 'custom:1', kind: 'custom', date: '2027-03-01', overdue: false, edition: { id: 'e', year: 2027, raceName: 'Test Marathon' }, ...over });
const PARAMS = { count: 1, detail: 'x', label: 'x', what: 'x' };

describe('key dates panel helpers', () => {
  it('only a stored date can be changed', () => {
    expect(isStored(item({ keyDateId: 'k', version: 0 }))).toBe(true);
    expect(isStored(item({ kind: 'allotment_release' }))).toBe(false);
  });

  it('builds the trip line and the calendar path', () => {
    expect(tripLabel({ raceName: 'Test Marathon', year: 2027 })).toBe('Test Marathon 2027');
    expect(calendarPath('')).toBe('/admin/key-dates');
    expect(calendarPath('abc')).toBe('/admin/key-dates?editionId=abc');
  });

  it('sends a label only with a custom date', () => {
    expect(createBody({ editionId: 'e', kind: 'custom', label: ' Bibs ', dueDate: '2027-03-01' })).toEqual({ editionId: 'e', kind: 'custom', label: 'Bibs', dueDate: '2027-03-01' });
    expect(createBody({ editionId: 'e', kind: 'entry_submission', label: 'left over', dueDate: '2027-03-01' })).toEqual({ editionId: 'e', kind: 'entry_submission', dueDate: '2027-03-01' });
    expect(addableKinds).toEqual([...KEY_DATE_KINDS]);
  });
});

describe('key dates panel copy', () => {
  it('every literal message key used by the panel exists', () => {
    const keys = new Set<string>();
    const files = [join(__dirname, '../components/admin/keydates/keydates-panel.tsx'), join(__dirname, '../app/admin/(panel)/key-dates/page.tsx')];
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'(admin\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThan(15);
    for (const k of keys) expect(() => t(k, PARAMS), k).not.toThrow();
  });

  it('has a label and a line for every kind of date', () => {
    for (const k of CALENDAR_ITEM_KINDS) {
      expect(() => t(`admin.keydates.kinds.${k}`, PARAMS), k).not.toThrow();
      expect(() => t(`admin.keydates.lines.${k}`, PARAMS), k).not.toThrow();
    }
  });

  it('has wording for every key date error code the API can return', () => {
    for (const code of ['entry_submission_exists', 'key_date_not_found', 'label_required', 'range_invalid', 'range_too_long', 'version_conflict', 'edition_not_found']) {
      expect(catalogueError({ status: 409, body: { code } }), code).not.toBe(t('admin.common.error'));
    }
  });

  it('never works out a date or a count in the browser', () => {
    const src = readFileSync(join(__dirname, '../components/admin/keydates/keydates-panel.tsx'), 'utf8');
    expect(src).not.toMatch(/reduce\(|new Date\(|Date\.now/);
  });
});
