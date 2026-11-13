import { describe, expect, it } from 'vitest';
import { reportDefinitionSchema, reportScheduleSchema } from '@mt/shared';
import { cell, columnsOf, defaultColumns, definitionOf, editableHere, emptyForm, formOf, groupsOf, saveBody, scheduleOf, toggleColumn, toggleRecipient, withEntity } from './reports-panel';
import type { SavedReportView } from './reports-panel';

describe('report builder form', () => {
  it('starts as a valid funnel report that is not scheduled', () => {
    const f = emptyForm();
    expect(reportDefinitionSchema.safeParse(definitionOf(f)).success).toBe(true);
    expect(scheduleOf(f)).toBeNull();
    expect(saveBody(f)).toMatchObject({ name: '', schedule: null, recipientUserIds: [] });
  });

  it('every default column and grouping of each entity passes the shared schema', () => {
    for (const entity of ['funnel', 'bookings'] as const) {
      const f = withEntity(emptyForm(), entity);
      expect(f.columns).toEqual(defaultColumns(entity));
      expect(groupsOf(entity)).toContain(f.groupBy);
      expect(reportDefinitionSchema.safeParse(definitionOf(f)).success).toBe(true);
    }
  });

  it('changing the entity resets columns and grouping, so a column of the other entity is never sent', () => {
    const f = withEntity({ ...emptyForm(), columns: ['views', 'requests'], groupBy: 'month' }, 'bookings');
    expect(f.columns.every((c) => columnsOf('bookings').includes(c))).toBe(true);
    expect(f.groupBy).toBe('race');
  });

  it('keeps columns in the catalogue order however they were ticked, and refuses nothing it did not offer', () => {
    let f = { ...emptyForm(), columns: [] as string[] };
    f = toggleColumn(f, 'paid', true);
    f = toggleColumn(f, 'views', true);
    expect(f.columns).toEqual(['views', 'paid']);
    expect(toggleColumn(f, 'views', false).columns).toEqual(['paid']);
    expect(toggleColumn(f, 'declined', true).columns).toEqual(['views', 'paid']);
  });

  it('builds a weekly and a monthly schedule the API accepts, and no recipients without a schedule', () => {
    const weekly = { ...emptyForm(), scheduled: true, weekday: '3', time: '08:00', recipientUserIds: ['a'] };
    expect(reportScheduleSchema.safeParse(scheduleOf(weekly)).success).toBe(true);
    expect(scheduleOf(weekly)).toEqual({ frequency: 'weekly', weekday: 3, time: '08:00' });
    const monthly = { ...weekly, frequency: 'monthly' as const, dayOfMonth: '28' };
    expect(scheduleOf(monthly)).toEqual({ frequency: 'monthly', dayOfMonth: 28, time: '08:00' });
    expect(reportScheduleSchema.safeParse(scheduleOf(monthly)).success).toBe(true);
    expect(saveBody({ ...weekly, scheduled: false })).toMatchObject({ schedule: null, recipientUserIds: [] });
  });

  it('adds a recipient once and removes one', () => {
    let f = emptyForm();
    f = toggleRecipient(toggleRecipient(f, 'a', true), 'a', true);
    expect(f.recipientUserIds).toEqual(['a']);
    expect(toggleRecipient(f, 'a', false).recipientUserIds).toEqual([]);
  });

  it('round-trips a saved report through the form, and only offers to edit what the form can hold', () => {
    const report: SavedReportView = {
      id: 'x', name: 'Weekly', entity: 'bookings', version: 3, recipientUserIds: ['u1'],
      definition: { entity: 'bookings', columns: ['bookings', 'paid'], groupBy: 'month', raceIds: ['r1'], range: { kind: 'last_days', days: 90 } },
      schedule: { frequency: 'monthly', dayOfMonth: 5, time: '07:30' },
    };
    const f = formOf(report);
    expect(f).toMatchObject({ name: 'Weekly', entity: 'bookings', raceId: 'r1', days: '90', scheduled: true, frequency: 'monthly', dayOfMonth: '5', time: '07:30', recipientUserIds: ['u1'] });
    expect(definitionOf(f)).toEqual(report.definition);
    expect(scheduleOf(f)).toEqual(report.schedule);
    expect(editableHere(report)).toBe(true);
    expect(editableHere({ ...report, definition: { ...report.definition, raceIds: ['a', 'b'] } })).toBe(false);
    expect(editableHere({ ...report, definition: { ...report.definition, range: { kind: 'dates', from: '2027-01-01', to: '2027-02-01' } } })).toBe(false);
  });
});

describe('table cells', () => {
  it.each([
    ['views', 12, '12'], ['views', 0, '0'], ['request_rate_pct', 12.5, '12.5%'], ['paid_rate_pct', 100, '100%'], ['paid_rate_pct', null, '–'], ['views', undefined, '–'],
  ])('%s %s -> %s', (column, value, expected) => expect(cell(column, value)).toBe(expected));
});
