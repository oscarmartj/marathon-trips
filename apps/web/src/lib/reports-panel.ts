import { BOOKING_COLUMNS, BOOKING_GROUPS, FUNNEL_COLUMNS, FUNNEL_GROUPS } from '@mt/shared';
import type { ReportDefinition, ReportResult, ReportSchedule } from '@mt/shared';

// Helpers for the funnel and report builder panel (task 7.7). Display and form shaping only: every count, rate and
// row comes from the API, and the web never works a figure out.

export type { ReportResult };
export type Entity = 'funnel' | 'bookings';

export interface SavedReportView {
  id: string;
  name: string;
  entity: Entity;
  definition: ReportDefinition;
  schedule: ReportSchedule | null;
  recipientUserIds: string[];
  version: number;
}

export const columnsOf = (entity: Entity): readonly string[] => (entity === 'funnel' ? FUNNEL_COLUMNS : BOOKING_COLUMNS);
export const groupsOf = (entity: Entity): readonly string[] => (entity === 'funnel' ? FUNNEL_GROUPS : BOOKING_GROUPS);
export const defaultColumns = (entity: Entity): string[] => (entity === 'funnel' ? ['views', 'builder_uses', 'requests', 'paid'] : ['bookings', 'approved', 'paid']);

export const FUNNEL_RANGES = [7, 30, 90, 365] as const;
export const funnelPath = (days: number): string => `/admin/reports/funnel?days=${days}`;

/** The state of the builder form. Everything is a string or a list so a form can hold it. */
export interface BuilderForm {
  name: string;
  entity: Entity;
  columns: string[];
  groupBy: string;
  raceId: string;
  days: string;
  scheduled: boolean;
  frequency: 'weekly' | 'monthly';
  weekday: string;
  dayOfMonth: string;
  time: string;
  recipientUserIds: string[];
}

export const emptyForm = (): BuilderForm => ({
  name: '', entity: 'funnel', columns: defaultColumns('funnel'), groupBy: 'race', raceId: '', days: '30',
  scheduled: false, frequency: 'weekly', weekday: '1', dayOfMonth: '1', time: '08:00', recipientUserIds: [],
});

/** Changing the entity resets what depends on it. */
export const withEntity = (form: BuilderForm, entity: Entity): BuilderForm => ({ ...form, entity, columns: defaultColumns(entity), groupBy: groupsOf(entity)[0]! });

/** Columns in the order the catalogue lists them, however the boxes were ticked. */
export const toggleColumn = (form: BuilderForm, column: string, on: boolean): BuilderForm => {
  const next = new Set(form.columns);
  if (on) next.add(column);
  else next.delete(column);
  return { ...form, columns: columnsOf(form.entity).filter((c) => next.has(c)) };
};

export const toggleRecipient = (form: BuilderForm, id: string, on: boolean): BuilderForm => ({
  ...form, recipientUserIds: on ? [...new Set([...form.recipientUserIds, id])] : form.recipientUserIds.filter((r) => r !== id),
});

export function definitionOf(form: BuilderForm): ReportDefinition {
  return {
    entity: form.entity, columns: form.columns, groupBy: form.groupBy,
    ...(form.raceId ? { raceIds: [form.raceId] } : {}),
    range: { kind: 'last_days', days: Number(form.days) },
  };
}

export function scheduleOf(form: BuilderForm): ReportSchedule | null {
  if (!form.scheduled) return null;
  return form.frequency === 'weekly'
    ? { frequency: 'weekly', weekday: Number(form.weekday), time: form.time }
    : { frequency: 'monthly', dayOfMonth: Number(form.dayOfMonth), time: form.time };
}

/** The body for a create or an update (an update adds the version). */
export const saveBody = (form: BuilderForm): Record<string, unknown> => ({
  name: form.name.trim(), definition: definitionOf(form), schedule: scheduleOf(form), recipientUserIds: form.scheduled ? form.recipientUserIds : [],
});

export function formOf(report: SavedReportView): BuilderForm {
  const d = report.definition;
  const s = report.schedule;
  return {
    name: report.name, entity: d.entity, columns: [...d.columns], groupBy: d.groupBy, raceId: d.raceIds?.[0] ?? '',
    days: d.range.kind === 'last_days' ? String(d.range.days) : '30',
    scheduled: !!s, frequency: s?.frequency ?? 'weekly', weekday: String(s?.weekday ?? 1), dayOfMonth: String(s?.dayOfMonth ?? 1), time: s?.time ?? '08:00',
    recipientUserIds: [...report.recipientUserIds],
  };
}

/** A report that filters on more than one race, or on dates, cannot be edited in this form without losing that. */
export const editableHere = (report: SavedReportView): boolean => (report.definition.raceIds?.length ?? 0) <= 1 && report.definition.range.kind === 'last_days';

/** A value as the table shows it: a rate has a percent sign, nothing to divide by is a dash. */
export function cell(column: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  return column.endsWith('_pct') ? `${value}%` : String(value);
}

export const TIMES: readonly string[] = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
