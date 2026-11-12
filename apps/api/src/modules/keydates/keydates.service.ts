import { Inject, Injectable } from '@nestjs/common';
import { KEY_DATE_LEAD_DAYS, KEY_DATE_LOOKBACK_DAYS } from '@mt/shared';
import type { CalendarItem, CalendarItemKind, calendarQuerySchema, createKeyDateSchema, deleteKeyDateSchema, updateKeyDateSchema } from '@mt/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { FeatureFlagService } from '../../platform/flags/flags.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { readBalancesDueForCalendar } from '../bookings';
import { listEditionLabels, readEditionLabels } from '../catalogue';
import { readHeldReleasesForCalendar } from '../suppliers';
import { addDays, longDate, startOfBusinessDay, todayInBusinessZone } from './dates';
import { KEYDATES_MODULE } from './manifest';

type Tx = Prisma.TransactionClient;
type Actor = AuditActor & { id: string };

const REF_PREFIX = 'keydate:';
const FAR_PAST = '1970-01-01';
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

interface Candidate extends CalendarItem {
  /** What the task is about. */
  entity: { type: string; id: string };
  title: string;
}

/**
 * The key dates calendar (task 7.3). It joins three sources: stored dates (this module), allotment release dates
 * (suppliers) and balance due dates (bookings, counts only). Every read is a plain query; nothing here touches money,
 * allotments or bookings. The sweep opens one task per upcoming date and closes it when the date no longer applies.
 */
@Injectable()
export class KeyDatesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
  ) {}

  /** Editions to choose from when adding a date. */
  async editions() {
    return { items: await this.prisma.$transaction((tx) => listEditionLabels(tx)) };
  }

  // ---- Stored dates ----

  private async editionExists(tx: Tx, editionId: string): Promise<void> {
    if (!(await tx.raceEdition.findFirst({ where: { id: editionId, race: { deletedAt: null } }, select: { id: true } }))) throw notFound('edition_not_found', 'Edition not found');
  }

  async create(actor: Actor, input: z.infer<typeof createKeyDateSchema>) {
    const { reason, label, dueDate, ...rest } = input;
    return this.prisma.$transaction(async (tx) => {
      await this.editionExists(tx, rest.editionId);
      if (rest.kind === 'entry_submission' && (await tx.keyDate.findFirst({ where: { editionId: rest.editionId, kind: 'entry_submission' }, select: { id: true } }))) {
        throw conflict('entry_submission_exists', 'This edition already has an entry submission deadline. Change that one instead.');
      }
      const row = await tx.keyDate.create({ data: { ...rest, label: label ?? null, dueDate: new Date(`${dueDate}T00:00:00.000Z`) } });
      await this.audit.record(tx, { actor, action: 'keydates.date.created', entityType: 'KeyDate', entityId: row.id, reason, after: this.view(row) });
      return this.view(row);
    });
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateKeyDateSchema>) {
    const { version, reason, label, dueDate } = input;
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.keyDate.findUnique({ where: { id } });
      if (!before) throw notFound('key_date_not_found', 'Key date not found');
      const nextLabel = label === undefined ? before.label : label;
      if (before.kind === 'custom' && !nextLabel) throw unprocessable('label_required', 'A custom date needs a label');
      const res = await tx.keyDate.updateMany({
        where: { id, version },
        data: { label: nextLabel, ...(dueDate ? { dueDate: new Date(`${dueDate}T00:00:00.000Z`) } : {}), version: { increment: 1 } },
      });
      if (res.count !== 1) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      const after = await tx.keyDate.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action: 'keydates.date.updated', entityType: 'KeyDate', entityId: id, reason, before: this.view(before), after: this.view(after) });
      return this.view(after);
    });
  }

  async remove(actor: Actor, id: string, input: z.infer<typeof deleteKeyDateSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.keyDate.findUnique({ where: { id } });
      if (!before) throw notFound('key_date_not_found', 'Key date not found');
      const res = await tx.keyDate.deleteMany({ where: { id, version: input.version } });
      if (res.count !== 1) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      await this.audit.record(tx, { actor, action: 'keydates.date.deleted', entityType: 'KeyDate', entityId: id, reason: input.reason, before: this.view(before) });
      // Its task has nothing left to be about.
      await this.tasks.closeSystemIn(tx, this.ref(before.kind as CalendarItemKind, id, day(before.dueDate)));
    });
  }

  private view(row: { id: string; editionId: string; kind: string; label: string | null; dueDate: Date; version: number }) {
    return { id: row.id, editionId: row.editionId, kind: row.kind, label: row.label, dueDate: day(row.dueDate), version: row.version };
  }

  // ---- The calendar ----

  private ref(kind: CalendarItemKind, thingId: string, date: string): string {
    return `${REF_PREFIX}${kind}:${thingId}:${date}`;
  }

  /** Every date in [from, to] from the three sources, oldest first. Pure reads, in one transaction for a consistent view. */
  private async collect(tx: Tx, from: string, to: string, today: string, editionId?: string): Promise<Candidate[]> {
    const [stored, releases, balances] = await Promise.all([
      tx.keyDate.findMany({ where: { dueDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) }, ...(editionId ? { editionId } : {}), edition: { race: { deletedAt: null } } } }),
      readHeldReleasesForCalendar(tx, from, to, editionId),
      readBalancesDueForCalendar(tx, from, to, editionId),
    ]);
    const labels = await readEditionLabels(tx, [...new Set([...stored.map((s) => s.editionId), ...releases.map((r) => r.editionId), ...balances.map((b) => b.editionId)])]);
    const out: Candidate[] = [];
    const push = (editionId2: string, c: Omit<Candidate, 'edition' | 'overdue' | 'title'> & { title: (trip: string) => string }) => {
      const e = labels.get(editionId2);
      if (!e) return; // the race was deleted
      const { title, ...rest } = c;
      out.push({ ...rest, edition: { id: e.id, year: e.year, raceName: e.raceName }, overdue: c.date < today, title: title(`${e.raceName} ${e.year}`) });
    };
    for (const s of stored) {
      const date = day(s.dueDate);
      const kind = s.kind as CalendarItemKind;
      push(s.editionId, {
        key: `${kind}:${s.id}`, kind, date, keyDateId: s.id, version: s.version, label: s.label, entity: { type: 'KeyDate', id: s.id },
        title: (trip) => (s.kind === 'entry_submission' ? `Entry submission deadline for ${trip} on ${longDate(date)}` : `${s.label}: ${trip} on ${longDate(date)}`),
      });
    }
    for (const r of releases) {
      push(r.editionId, {
        key: `allotment_release:${r.id}`, kind: 'allotment_release', date: r.releaseDate, count: r.quantity, detail: `${r.supplierName}: ${r.poolLabel}`, entity: { type: 'Allotment', id: r.id },
        title: (trip) => `Allotment release for ${trip} on ${longDate(r.releaseDate)}: ${plural(r.quantity, r.kind === 'room' ? 'room' : 'entry', r.kind === 'room' ? 'rooms' : 'entries')} held by ${r.supplierName} (${r.poolLabel})`,
      });
    }
    for (const b of balances) {
      push(b.editionId, {
        key: `balance_due:${b.editionId}:${b.dueDate}`, kind: 'balance_due', date: b.dueDate, count: b.bookings, entity: { type: 'RaceEdition', id: b.editionId },
        title: (trip) => `${plural(b.bookings, 'balance is', 'balances are')} due for ${trip} on ${longDate(b.dueDate)}`,
      });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : 1));
  }

  private taskRefOf(c: Candidate): string {
    const thing = c.kind === 'balance_due' ? c.edition.id : c.key.split(':')[1]!;
    return this.ref(c.kind, thing, c.date);
  }

  /** The calendar for a window (default: the last 30 days and the next 90), each date with its open task if there is one. */
  async calendar(q: z.infer<typeof calendarQuerySchema>, now: Date = new Date()) {
    const today = todayInBusinessZone(now);
    const from = q.from ?? addDays(today, -KEY_DATE_LOOKBACK_DAYS);
    const to = q.to ?? addDays(from, 120);
    if (to < from) throw unprocessable('range_invalid', 'The last day is before the first day');
    if (addDays(from, 732) < to) throw unprocessable('range_too_long', 'Choose a range of two years or less');
    return this.prisma.$transaction(async (tx) => {
      const items = await this.collect(tx, from, to, today, q.editionId);
      const refs = items.map((i) => this.taskRefOf(i));
      const open = refs.length ? await tx.task.findMany({ where: { sourceRef: { in: refs }, source: 'system', status: 'open', deletedAt: null }, select: { id: true, sourceRef: true } }) : [];
      const byRef = new Map(open.map((t) => [t.sourceRef, t.id]));
      return {
        today, from, to,
        items: items.map((c): CalendarItem => {
          const { entity: _entity, title: _title, ...item } = c;
          return { ...item, taskId: byRef.get(this.taskRefOf(c)) ?? null };
        }),
      };
    });
  }

  // ---- Automatic tasks ----

  /**
   * Opens one task for each date that is within KEY_DATE_LEAD_DAYS (or up to KEY_DATE_LOOKBACK_DAYS overdue) and closes
   * the open ones whose date was released, paid, moved or deleted. A task that was closed or deleted by a person is not
   * opened again. Safe to run at the same time on two instances (advisory lock) and to repeat.
   */
  async sweep(now: Date = new Date()): Promise<{ opened: number; closed: number }> {
    if (!(await this.flags.isModuleEnabled(KEYDATES_MODULE))) return { opened: 0, closed: 0 };
    const today = todayInBusinessZone(now);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('keydates:sweep'))`;
      const horizon = addDays(today, KEY_DATE_LEAD_DAYS);
      const all = await this.collect(tx, FAR_PAST, horizon, today);
      const live = new Set(all.map((c) => this.taskRefOf(c)));
      let opened = 0;
      for (const c of all) {
        if (c.date < addDays(today, -KEY_DATE_LOOKBACK_DAYS)) continue;
        const ref = this.taskRefOf(c);
        if (await tx.task.findFirst({ where: { sourceRef: ref, source: 'system' }, select: { id: true } })) continue;
        await this.tasks.createSystemIn(tx, { title: c.title, dueAt: startOfBusinessDay(c.date), entityType: c.entity.type, entityId: c.entity.id, sourceRef: ref });
        opened += 1;
      }
      let closed = 0;
      const openTasks = await tx.task.findMany({ where: { source: 'system', status: 'open', deletedAt: null, sourceRef: { startsWith: REF_PREFIX } }, select: { sourceRef: true } });
      for (const t of openTasks) {
        if (t.sourceRef && !live.has(t.sourceRef) && !this.beyondHorizon(t.sourceRef, horizon)) closed += await this.tasks.closeSystemIn(tx, t.sourceRef);
      }
      return { opened, closed };
    });
  }

  /** The date is the last part of the reference. A task for a date past the horizon is not looked at (it was moved there). */
  private beyondHorizon(sourceRef: string, horizon: string): boolean {
    return sourceRef.slice(-10) > horizon;
  }
}
