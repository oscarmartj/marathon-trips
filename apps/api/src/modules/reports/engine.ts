import { Injectable } from '@nestjs/common';
import { REPORT_ENTITY_CATALOGUE, REPORT_MAX_ROWS } from '@mt/shared';
import type { ReportDefinition, ReportResult } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { addDays, resolveRange, startOfBusinessDay } from './dates';
import { REPORTS_TIME_ZONE } from './manifest';

type Tx = Prisma.TransactionClient;
type Counts = Record<string, number>;

const PAID = Prisma.raw(`'deposit_paid', 'confirmed', 'balance_paid', 'completed'`);
const raceName = Prisma.raw(`COALESCE(r."name"->>'en-AU', r."slug")`);
const requestedDay = Prisma.raw(`(b."requestedAt" AT TIME ZONE '${REPORTS_TIME_ZONE}')::date`);

/** Group expressions: constants chosen from a closed list, never text from a request. */
const BOOKING_GROUPS: Record<string, { key: Prisma.Sql; label: Prisma.Sql; joins: Prisma.Sql }> = {
  race: { key: Prisma.raw(`r."id"::text`), label: raceName, joins: Prisma.empty },
  edition: { key: Prisma.raw(`e."id"::text`), label: Prisma.raw(`COALESCE(r."name"->>'en-AU', r."slug") || ' ' || e."year"::text`), joins: Prisma.empty },
  package: {
    key: Prisma.raw(`p."id"::text`),
    label: Prisma.raw(`COALESCE(r."name"->>'en-AU', r."slug") || ' ' || e."year"::text || ': ' || COALESCE(p."name"->>'en-AU', p."slug")`),
    joins: Prisma.raw(`JOIN "packages" p ON p."id" = b."packageId"`),
  },
  channel: { key: Prisma.raw(`b."sourceChannel"::text`), label: Prisma.raw(`b."sourceChannel"::text`), joins: Prisma.empty },
  month: { key: Prisma.raw(`to_char(date_trunc('month', ${requestedDay.sql}), 'YYYY-MM')`), label: Prisma.raw(`to_char(date_trunc('month', ${requestedDay.sql}), 'YYYY-MM')`), joins: Prisma.empty },
  none: { key: Prisma.raw(`'all'`), label: Prisma.raw(`'All races'`), joins: Prisma.empty },
};
const STAT_GROUPS: Record<string, { key: Prisma.Sql; label: Prisma.Sql }> = {
  race: { key: Prisma.raw(`r."id"::text`), label: raceName },
  month: { key: Prisma.raw(`to_char(date_trunc('month', s."day"), 'YYYY-MM')`), label: Prisma.raw(`to_char(date_trunc('month', s."day"), 'YYYY-MM')`) },
  none: { key: Prisma.raw(`'all'`), label: Prisma.raw(`'All races'`) },
};

/** One decimal, integer arithmetic. Null when there is nothing to divide by. */
export const ratePct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part * 1000) / whole) / 10 : null);

/**
 * The one place a report is computed (task 7.7). Plain reads: bookings are counted by the day they were requested
 * (a cohort, so a rate never passes 100), visits come from the anonymous daily counters. No amounts, no people.
 */
@Injectable()
export class ReportEngine {
  async run(tx: Tx, def: ReportDefinition, now: Date = new Date(), opts: { completeDaysOnly?: boolean } = {}): Promise<ReportResult> {
    const { from, to } = resolveRange(def.range, now, opts);
    // Bounds as instants, so the filter on the request time can use an index (no expression on the column).
    const [fromAt, beforeAt] = [startOfBusinessDay(from), startOfBusinessDay(addDays(to, 1))];
    const raceFilter = (col: string) => (def.raceIds?.length ? Prisma.sql`AND ${Prisma.raw(col)} = ANY(${def.raceIds}::uuid[])` : Prisma.empty);
    const rows = new Map<string, { label: string; counts: Counts }>();
    const add = (key: string, label: string, counts: Counts) => {
      const row = rows.get(key) ?? { label, counts: {} };
      Object.assign(row.counts, counts);
      rows.set(key, row);
    };

    const g = BOOKING_GROUPS[def.groupBy];
    if (!g) throw new Error(`unknown grouping ${def.groupBy}`);
    const booked = await tx.$queryRaw<Array<{ key: string; label: string; requests: number; approved: number; declined: number; expired: number; cancelled: number; paid: number }>>(Prisma.sql`
      SELECT ${g.key} AS key, ${g.label} AS label,
        count(*)::int AS requests,
        (count(*) FILTER (WHERE b."approvedAt" IS NOT NULL))::int AS approved,
        (count(*) FILTER (WHERE b."declinedAt" IS NOT NULL))::int AS declined,
        (count(*) FILTER (WHERE b."expiredAt" IS NOT NULL))::int AS expired,
        (count(*) FILTER (WHERE b."cancelledAt" IS NOT NULL))::int AS cancelled,
        (count(*) FILTER (WHERE b."status"::text IN (${PAID})))::int AS paid
      FROM "bookings" b
      JOIN "race_editions" e ON e."id" = b."editionId"
      JOIN "races" r ON r."id" = e."raceId"
      ${g.joins}
      WHERE r."deletedAt" IS NULL AND NOT r."isDemo" AND NOT b."isDemo" AND b."requestedAt" >= ${fromAt}::timestamptz AND b."requestedAt" < ${beforeAt}::timestamptz ${raceFilter('r."id"')}
      GROUP BY 1, 2`);
    for (const b of booked) add(b.key, b.label, { requests: b.requests, bookings: b.requests, approved: b.approved, declined: b.declined, expired: b.expired, cancelled: b.cancelled, paid: b.paid });

    if (def.entity === 'funnel') {
      const sg = STAT_GROUPS[def.groupBy]!;
      const seen = await tx.$queryRaw<Array<{ key: string; label: string; views: number; builder: number }>>(Prisma.sql`
        SELECT ${sg.key} AS key, ${sg.label} AS label, COALESCE(sum(s."views"), 0)::int AS views, COALESCE(sum(s."builderUses"), 0)::int AS builder
        FROM "race_daily_stats" s JOIN "races" r ON r."id" = s."raceId"
        WHERE r."deletedAt" IS NULL AND NOT r."isDemo" AND s."day" BETWEEN ${from}::date AND ${to}::date ${raceFilter('r."id"')}
        GROUP BY 1, 2`);
      for (const s of seen) add(s.key, s.label, { views: s.views, builder_uses: s.builder });
    }

    const wanted = def.columns;
    const ordered = [...rows.entries()].sort(([ak, a], [bk, b]) => (def.groupBy === 'month' ? (ak < bk ? -1 : 1) : a.label.localeCompare(b.label, 'en-AU') || (ak < bk ? -1 : 1)));
    const out = ordered.slice(0, REPORT_MAX_ROWS).map(([key, row]) => {
      const c = row.counts;
      const all: Record<string, number | null> = {
        views: c.views ?? 0, builder_uses: c.builder_uses ?? 0, requests: c.requests ?? 0, bookings: c.bookings ?? 0, approved: c.approved ?? 0,
        declined: c.declined ?? 0, expired: c.expired ?? 0, cancelled: c.cancelled ?? 0, paid: c.paid ?? 0,
        request_rate_pct: ratePct(c.requests ?? 0, c.views ?? 0), paid_rate_pct: ratePct(c.paid ?? 0, c.requests ?? 0),
      };
      return { key, label: row.label, values: Object.fromEntries(wanted.map((col) => [col, all[col] ?? null])) };
    });
    return { columns: wanted, groupBy: def.groupBy, from, to, rows: out, truncated: ordered.length > REPORT_MAX_ROWS };
  }

  /** Every column of the funnel, for the funnel page. */
  funnel(tx: Tx, range: ReportDefinition['range'], now?: Date): Promise<ReportResult> {
    return this.run(tx, { entity: 'funnel', columns: [...REPORT_ENTITY_CATALOGUE.funnel.columns], groupBy: 'race', range }, now);
  }
}
