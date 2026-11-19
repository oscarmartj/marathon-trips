// Task 6.2 (plan docs/plans/6.2-supplier-payments.md, sections 3 and 7): what is owed to suppliers and when, worked out on
// request from the cost items and the held allotments, and the tasks that warn about it. Reads only; tasks are opened
// and closed through TasksService. Titles carry no amounts and no personal data (cost descriptions are @pii).
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { supplierScheduleQuerySchema } from '@mt/shared';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { PrismaService } from '../../platform/database/prisma.service';
import type { DeliveredEvent } from '../../platform/events/consumers';
import { FeatureFlagService } from '../../platform/flags/flags.service';
import { unprocessable } from '../../platform/http/api-error';
import { costAmount } from './cost.service';
import { DueBucket, SUPPLIER_PAYMENT_LEAD_DAYS, addDays, dueBucket, endOfBrisbaneDay, longDate, todayInBrisbane } from './dates';
import { Tx, fromDate, toDate } from './support';

type ScheduleQuery = z.infer<typeof supplierScheduleQuerySchema>;

export const SUPPLIERS_MODULE = 'suppliers';
const REF = {
  upcoming: (costItemId: string, generation: number, dueDate: string) => `suppliers:payment_upcoming:${costItemId}:g${generation}:${dueDate}`,
  overdue: (costItemId: string, generation: number, dueDate: string) => `suppliers:payment_overdue:${costItemId}:g${generation}:${dueDate}`,
  releasePassed: (allotmentId: string, releaseDate: string) => `suppliers:release_passed:${allotmentId}:${releaseDate}`,
  costReview: (packageId: string) => `suppliers:cost_review:${packageId}`,
};
const SWEPT_PREFIXES = ['suppliers:payment_upcoming:', 'suppliers:payment_overdue:', 'suppliers:release_passed:'];

const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};

export interface ScheduleItem {
  costItemId: string;
  supplierId: string;
  supplierName: string;
  contractId: string | null;
  contractReference: string | null;
  packageId: string | null;
  description: string;
  dueDate: string | null;
  bucket: DueBucket;
  status: string;
  amountMinor: string;
  currency: string;
  version: number;
}

export interface ScheduleRelease {
  allotmentId: string;
  supplierId: string;
  supplierName: string;
  contractReference: string;
  poolLabel: string;
  kind: string;
  releaseDate: string;
  passed: boolean;
  quantity: number;
  unitCostMinor: string;
  atStakeMinor: string;
  currency: string;
}

interface Wanted {
  title: string;
  dueAt: Date | null;
  entityType: string;
  entityId: string;
}

@Injectable()
export class PaymentScheduleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
  ) {}

  /**
   * The schedule for a window (default today to 90 days ahead). Overdue and undated items are always listed, whatever the
   * window. Totals per bucket and currency, and the release dates at stake with their own totals: never added together.
   */
  async schedule(q: ScheduleQuery, now: Date = new Date()) {
    const today = todayInBrisbane(now);
    const from = q.from ?? today;
    const to = q.to ?? addDays(from, 90);
    if (to < from) throw unprocessable('range_invalid', 'The last day is before the first day');
    if (addDays(from, 732) < to) throw unprocessable('range_too_long', 'Choose a range of two years or less');
    return this.prisma.$transaction(async (tx) => {
      const costs = await tx.costItem.findMany({
        where: {
          status: { in: ['planned', 'due'] }, supplier: { deletedAt: null },
          ...(q.supplierId ? { supplierId: q.supplierId } : {}), ...(q.packageId ? { packageId: q.packageId } : {}), ...(q.currency ? { currency: q.currency } : {}),
          OR: [{ dueDate: null }, { dueDate: { lt: toDate(today) } }, { dueDate: { gte: toDate(from), lte: toDate(to) } }],
        },
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        select: { id: true, supplierId: true, contractId: true, packageId: true, description: true, dueDate: true, status: true, amountMinor: true, currency: true, version: true, supplier: { select: { name: true } }, contract: { select: { reference: true } } },
      });
      const items: ScheduleItem[] = costs.map((c) => {
        const due = fromDate(c.dueDate);
        return {
          costItemId: c.id, supplierId: c.supplierId, supplierName: c.supplier.name, contractId: c.contractId, contractReference: c.contract?.reference ?? null, packageId: c.packageId,
          description: c.description, dueDate: due, bucket: dueBucket(due, today), status: c.status, amountMinor: c.amountMinor.toString(), currency: c.currency, version: c.version,
        };
      });
      const totals = new Map<string, bigint>();
      for (const i of items) totals.set(`${i.bucket}|${i.currency}`, (totals.get(`${i.bucket}|${i.currency}`) ?? 0n) + BigInt(i.amountMinor));

      let editionId: string | undefined;
      if (q.packageId) editionId = (await tx.package.findUnique({ where: { id: q.packageId }, select: { editionId: true } }))?.editionId ?? '00000000-0000-0000-0000-000000000000';
      const held = await tx.allotment.findMany({
        where: {
          status: 'held', releaseDate: { not: null }, contract: { deletedAt: null, supplier: { deletedAt: null }, ...(q.supplierId ? { supplierId: q.supplierId } : {}) },
          ...(q.currency ? { currency: q.currency } : {}), ...(editionId ? { pool: { editionId } } : {}),
          OR: [{ releaseDate: { lt: toDate(today) } }, { releaseDate: { gte: toDate(from), lte: toDate(to) } }],
        },
        orderBy: [{ releaseDate: 'asc' }, { id: 'asc' }],
        select: { id: true, kind: true, quantity: true, releaseDate: true, unitCostMinor: true, currency: true, pool: { select: { label: true } }, contract: { select: { reference: true, supplierId: true, supplier: { select: { name: true } } } } },
      });
      const releases: ScheduleRelease[] = held.map((a) => {
        const date = fromDate(a.releaseDate)!;
        return {
          allotmentId: a.id, supplierId: a.contract.supplierId, supplierName: a.contract.supplier.name, contractReference: a.contract.reference, poolLabel: a.pool.label, kind: a.kind,
          releaseDate: date, passed: date < today, quantity: a.quantity, unitCostMinor: a.unitCostMinor.toString(), atStakeMinor: costAmount(a.quantity, a.unitCostMinor).toString(), currency: a.currency,
        };
      });
      const releaseTotals = new Map<string, bigint>();
      for (const r of releases) releaseTotals.set(r.currency, (releaseTotals.get(r.currency) ?? 0n) + BigInt(r.atStakeMinor));

      return {
        today, from, to, leadDays: SUPPLIER_PAYMENT_LEAD_DAYS, items,
        totals: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ bucket: k.split('|')[0]!, currency: k.split('|')[1]!, amountMinor: v.toString() })),
        releases,
        releaseTotals: [...releaseTotals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, v]) => ({ currency, atStakeMinor: v.toString() })),
      };
    });
  }

  // ---- Alerts (section 7) ----

  /**
   * Opens one task per upcoming payment (from 7 days before), per overdue payment (from the day after, no age limit) and
   * per release date passed with places still held, and closes those whose cost was paid, called off or re-dated, or whose
   * allotment was released. A reference that ever had a task is never opened again (a person may have closed it); a void
   * starts a new generation of references for its cost items. Safe to run on two instances at once and to repeat.
   */
  async sweep(now: Date = new Date()): Promise<{ opened: number; closed: number }> {
    if (!(await this.flags.isModuleEnabled(SUPPLIERS_MODULE))) return { opened: 0, closed: 0 };
    const today = todayInBrisbane(now);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('suppliers:payment_alerts'))`;
      const wanted = await this.wanted(tx, today);
      let opened = 0;
      for (const [ref, w] of wanted) {
        if (await tx.task.findFirst({ where: { sourceRef: ref, source: 'system' }, select: { id: true } })) continue;
        await this.tasks.createSystemIn(tx, { title: w.title, dueAt: w.dueAt, entityType: w.entityType, entityId: w.entityId, sourceRef: ref });
        opened += 1;
      }
      let closed = 0;
      const open = await tx.task.findMany({ where: { source: 'system', status: 'open', deletedAt: null, OR: SWEPT_PREFIXES.map((p) => ({ sourceRef: { startsWith: p } })) }, select: { sourceRef: true } });
      for (const t of open) if (t.sourceRef && !wanted.has(t.sourceRef)) closed += await this.tasks.closeSystemIn(tx, t.sourceRef);
      return { opened, closed };
    });
  }

  private async wanted(tx: Tx, today: string): Promise<Map<string, Wanted>> {
    const out = new Map<string, Wanted>();
    const costs = await tx.$queryRaw<Array<{ id: string; dueDate: Date; name: string; generation: number }>>`
      SELECT c.id::text AS id, c."dueDate", s.name,
        (SELECT count(*)::int FROM supplier_payment_items i WHERE i."costItemId" = c.id AND NOT i.active) AS generation
      FROM cost_items c JOIN suppliers s ON s.id = c."supplierId"
      WHERE c.status IN ('planned', 'due') AND c."dueDate" IS NOT NULL AND c."dueDate" <= ${toDate(addDays(today, SUPPLIER_PAYMENT_LEAD_DAYS))}::date AND s."deletedAt" IS NULL`;
    for (const c of costs) {
      const due = fromDate(c.dueDate)!;
      if (due < today) {
        out.set(REF.overdue(c.id, c.generation, due), { title: `Supplier payment to ${c.name} was due on ${longDate(due)} and is not recorded as paid`, dueAt: endOfBrisbaneDay(due), entityType: 'CostItem', entityId: c.id });
      } else {
        out.set(REF.upcoming(c.id, c.generation, due), { title: `Supplier payment to ${c.name} is due on ${longDate(due)}`, dueAt: endOfBrisbaneDay(due), entityType: 'CostItem', entityId: c.id });
      }
    }
    const passed = await tx.allotment.findMany({
      where: { status: 'held', releaseDate: { lt: toDate(today) }, contract: { deletedAt: null, supplier: { deletedAt: null } } },
      select: { id: true, releaseDate: true, pool: { select: { label: true } }, contract: { select: { reference: true, supplier: { select: { name: true } } } } },
    });
    for (const a of passed) {
      const date = fromDate(a.releaseDate)!;
      out.set(REF.releasePassed(a.id, date), {
        title: `Release date ${longDate(date)} passed with places still held from ${a.contract.supplier.name} (${a.pool.label}, contract ${a.contract.reference}): record the cost of the places kept, or release them`,
        dueAt: null, entityType: 'Allotment', entityId: a.id,
      });
    }
    return out;
  }

  // ---- Cancellation and amendment effects (section 3.4, plan review point 7) ----

  /**
   * A booking was cancelled or changed: when its trip still has unpaid supplier costs, or its edition has places held
   * whose release date is today or later, one review task per trip while open. Nothing changes by itself.
   */
  async onBookingChanged(event: DeliveredEvent, tx: Tx): Promise<void> {
    const bookingId = (event.payload as { bookingId?: string } | null)?.bookingId;
    if (!bookingId) return;
    const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: { reference: true, packageId: true, editionId: true } });
    if (!booking?.packageId) return;
    const today = todayInBrisbane(event.occurredAt);
    const unpaid = await tx.costItem.count({ where: { packageId: booking.packageId, status: { in: ['planned', 'due'] } } });
    const held = await tx.allotment.count({ where: { status: 'held', releaseDate: { gte: toDate(today) }, pool: { editionId: booking.editionId }, contract: { deletedAt: null } } });
    if (unpaid + held === 0) return;
    const pkg = await tx.package.findUnique({ where: { id: booking.packageId }, select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } });
    const trip = pkg ? `${en(pkg.edition.race.name)} ${pkg.edition.year}: ${en(pkg.name)}` : 'a trip';
    const what = event.type === 'bookings.booking.amended' ? 'changed' : 'cancelled';
    await this.tasks.createSystemIn(tx, {
      title: `A booking on ${trip} was ${what}: check supplier costs and places still held`,
      description: `Booking ${booking.reference} was ${what}. Check whether supplier costs or held places for this trip should change before their due and release dates. Nothing was changed automatically.`,
      entityType: 'Package', entityId: booking.packageId, sourceRef: REF.costReview(booking.packageId),
    });
  }
}
