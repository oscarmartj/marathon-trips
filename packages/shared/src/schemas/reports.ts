import { z } from 'zod';
import { isoDateSchema, slugSchema, versionSchema } from './catalogue';

// Funnel per race and the report builder (task 7.7). A closed catalogue: a report picks an entity, columns from that
// entity, one grouping, a date range and optionally some races. Nothing here carries a person or an amount of money.
// Strict objects: an unknown field is a 422.

export const REPORT_ENTITIES = ['funnel', 'bookings'] as const;
export type ReportEntity = (typeof REPORT_ENTITIES)[number];

export const FUNNEL_COLUMNS = ['views', 'builder_uses', 'requests', 'approved', 'paid', 'request_rate_pct', 'paid_rate_pct'] as const;
export const BOOKING_COLUMNS = ['bookings', 'approved', 'declined', 'expired', 'cancelled', 'paid'] as const;
export const FUNNEL_GROUPS = ['race', 'month', 'none'] as const;
export const BOOKING_GROUPS = ['race', 'edition', 'package', 'channel', 'month'] as const;

/** The columns, groupings and the permission that each entity needs. */
export const REPORT_ENTITY_CATALOGUE = {
  funnel: { columns: FUNNEL_COLUMNS as readonly string[], groups: FUNNEL_GROUPS as readonly string[], permission: 'reports.funnel.read' },
  bookings: { columns: BOOKING_COLUMNS as readonly string[], groups: BOOKING_GROUPS as readonly string[], permission: 'bookings.booking.read' },
} as const satisfies Record<ReportEntity, { columns: readonly string[]; groups: readonly string[]; permission: string }>;

export const REPORT_MAX_ROWS = 500;
export const REPORT_EMAIL_ROWS = 100;
export const REPORT_MAX_RECIPIENTS = 20;

export const reportRangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('last_days'), days: z.number().int().min(1).max(366) }),
  z.strictObject({ kind: z.literal('dates'), from: isoDateSchema, to: isoDateSchema }),
]);

export const reportScheduleSchema = z
  .strictObject({
    frequency: z.enum(['weekly', 'monthly']),
    /** 1 (Monday) to 7 (Sunday). */
    weekday: z.number().int().min(1).max(7).optional(),
    /** 1 to 28, so every month has the day. */
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    /** Brisbane time, in five-minute steps. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5][05]$/),
  })
  .refine((s) => (s.frequency === 'weekly' ? s.weekday !== undefined && s.dayOfMonth === undefined : s.dayOfMonth !== undefined && s.weekday === undefined), {
    message: 'A weekly schedule needs a weekday and a monthly one a day of the month',
  });

export const reportDefinitionSchema = z
  .strictObject({
    entity: z.enum(REPORT_ENTITIES),
    columns: z.array(z.string()).min(1).max(10),
    groupBy: z.string(),
    raceIds: z.array(z.uuid()).max(50).optional(),
    range: reportRangeSchema,
  })
  .superRefine((d, ctx) => {
    const c = REPORT_ENTITY_CATALOGUE[d.entity];
    if (new Set(d.columns).size !== d.columns.length) ctx.addIssue({ code: 'custom', path: ['columns'], message: 'Each column can be chosen once' });
    d.columns.forEach((col, i) => {
      if (!c.columns.includes(col)) ctx.addIssue({ code: 'custom', path: ['columns', i], message: `${col} is not a column of ${d.entity}` });
    });
    if (!c.groups.includes(d.groupBy)) ctx.addIssue({ code: 'custom', path: ['groupBy'], message: `${d.groupBy} is not a grouping of ${d.entity}` });
    if (d.range.kind === 'dates' && d.range.to < d.range.from) ctx.addIssue({ code: 'custom', path: ['range', 'to'], message: 'The last day is before the first day' });
    if (d.range.kind === 'dates' && Date.parse(d.range.to) - Date.parse(d.range.from) > 366 * 86_400_000) ctx.addIssue({ code: 'custom', path: ['range', 'to'], message: 'Choose a range of a year or less' });
  });
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;

const name = z.string().trim().min(1).max(120);
const recipients = z.array(z.uuid()).max(REPORT_MAX_RECIPIENTS).refine((a) => new Set(a).size === a.length, { message: 'Each recipient once' });

export const createReportSchema = z.strictObject({ name, definition: reportDefinitionSchema, schedule: reportScheduleSchema.nullable().optional(), recipientUserIds: recipients.optional() });
export const updateReportSchema = z.strictObject({
  name: name.optional(),
  definition: reportDefinitionSchema.optional(),
  schedule: reportScheduleSchema.nullable().optional(),
  recipientUserIds: recipients.optional(),
  version: versionSchema,
});
export const deleteReportSchema = z.strictObject({ version: z.coerce.number().int().min(0) });
export const previewReportSchema = z.strictObject({ definition: reportDefinitionSchema });

/** The funnel page: the last N days, or two dates. */
export const funnelQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(366).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

/** What the race page and the package page send. Anonymous: a slug and a kind. */
export const raceEventSchema = z.strictObject({ raceSlug: slugSchema, kind: z.enum(['view', 'builder']) });

export interface ReportResult {
  columns: string[];
  groupBy: string;
  from: string;
  to: string;
  rows: Array<{ key: string; label: string; values: Record<string, number | null> }>;
  truncated: boolean;
}
