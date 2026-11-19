// Task 6.2 (plan docs/plans/6.2-supplier-payments.md, section 4): payments to suppliers, RECORDED after the fact. The app
// never sends money: Oscar pays from his bank and records it here. The amount is the sum of the cost items, worked out
// from the locked rows; the only amount staff type is what the bank debited in another currency (a bank fact, never
// converted). Lock order (plan 0.1, 6.3): cost items by id ascending, then the supplier payment.
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { previewSupplierPaymentSchema, recordSupplierPaymentSchema, voidSupplierPaymentSchema } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { AppError } from '../../platform/errors/safe-error';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { IdempotencyInProgressError, IdempotencyKeyReuseError, IdempotencyService } from '../../platform/idempotency/idempotency.service';
import { SupplierLedger } from '../payments';
import type { SupplierPaymentRef } from '../payments';
import { addDays, todayInBrisbane } from './dates';
import { SUPPLIER_PAYMENT_EVENTS } from './manifest';
import { Tx, fromDate, toDate, versionConflict } from './support';

type Actor = AuditActor & { id: string };
type RecordInput = z.infer<typeof recordSupplierPaymentSchema>;
type PreviewInput = z.infer<typeof previewSupplierPaymentSchema>;
type VoidInput = z.infer<typeof voidSupplierPaymentSchema>;

export const RECORD_ROUTE = 'POST /admin/suppliers/:id/payments';
export const VOID_ROUTE = 'POST /admin/suppliers/payments/:id/void';
/** A payment dated more than this many days ago is refused (plan review, point 9). */
export const PAID_ON_MAX_AGE_DAYS = 366;
/** Alert task references of a cost item start with these (section 7); the sweep and recording close them. */
export const alertRefPrefixes = (costItemId: string): string[] => [`suppliers:payment_upcoming:${costItemId}:`, `suppliers:payment_overdue:${costItemId}:`];

interface LockedCost {
  id: string;
  supplierId: string;
  status: string;
  version: number;
  amountMinor: bigint;
  currency: string;
}

const PAYMENT_SELECT = {
  id: true, supplierId: true, mode: true, amountMinor: true, currency: true, baseAmountMinor: true, baseCurrency: true, paidOn: true, reference: true,
  status: true, recordedById: true, recordedAt: true, voidedAt: true, voidedById: true, voidReason: true, version: true,
  items: { orderBy: { costItemId: 'asc' }, select: { costItemId: true, amountMinor: true, currency: true, active: true, costItem: { select: { description: true, dueDate: true, packageId: true, contractId: true } } } },
} satisfies Prisma.SupplierPaymentSelect;
type PaymentRow = Prisma.SupplierPaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

export interface SupplierPaymentView {
  id: string;
  supplierId: string;
  mode: string;
  amountMinor: string;
  currency: string;
  base: { amountMinor: string; currency: string } | null;
  paidOn: string;
  reference: string;
  status: string;
  recordedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
  items: Array<{ costItemId: string; amountMinor: string; currency: string; active: boolean; description: string; dueDate: string | null; packageId: string | null; contractId: string | null }>;
}

export interface SupplierPaymentOutcome {
  id: string;
  supplierId: string;
  mode: string;
  status: string;
  version: number;
  paidOn: string;
  items: number;
}

export function paymentView(p: PaymentRow): SupplierPaymentView {
  return {
    id: p.id, supplierId: p.supplierId, mode: p.mode, amountMinor: p.amountMinor.toString(), currency: p.currency,
    base: p.baseAmountMinor !== null && p.baseCurrency ? { amountMinor: p.baseAmountMinor.toString(), currency: p.baseCurrency } : null,
    paidOn: fromDate(p.paidOn)!, reference: p.reference, status: p.status, recordedAt: p.recordedAt.toISOString(), voidedAt: p.voidedAt?.toISOString() ?? null,
    voidReason: p.voidReason, version: p.version,
    items: p.items.map((i) => ({
      costItemId: i.costItemId, amountMinor: i.amountMinor.toString(), currency: i.currency, active: i.active, description: i.costItem.description,
      dueDate: fromDate(i.costItem.dueDate), packageId: i.costItem.packageId, contractId: i.costItem.contractId,
    })),
  };
}

const ref = (p: { id: string; mode: 'test' | 'live'; amountMinor: bigint; currency: string; baseAmountMinor: bigint | null; baseCurrency: string | null }): SupplierPaymentRef => ({
  id: p.id, mode: p.mode, amountMinor: p.amountMinor, currency: p.currency, baseAmountMinor: p.baseAmountMinor, baseCurrency: p.baseCurrency,
});

/** Plan 0.1, 1.2: the business key is made by the server from the staff scope and the client's key, never the raw header. */
export const supplierPaymentKey = (actorId: string, clientKey: string): string =>
  `staff:${createHash('sha256').update(`${IdempotencyService.scope({ actorType: 'staff', actorId, route: RECORD_ROUTE })}\n${clientKey}`).digest('hex')}`;

const keyReused = () => unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');

/** The idempotency layer's own errors, as the API's usual codes. */
function asApiError(err: unknown): unknown {
  if (err instanceof IdempotencyKeyReuseError) return keyReused();
  if (err instanceof IdempotencyInProgressError) return conflict('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed');
  return err;
}

const isUniqueViolation = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class SupplierPaymentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(SupplierLedger) private readonly ledger: SupplierLedger,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  /** A payment of the environment's mode only (plan 0.1, P11; code review, m6). Needs `suppliers.cost.read` at the route. */
  async get(id: string): Promise<SupplierPaymentView> {
    const row = await this.prisma.supplierPayment.findFirst({ where: { id, mode: this.ledger.mode }, select: PAYMENT_SELECT });
    if (!row) throw notFound('supplier_payment_not_found', 'Supplier payment not found');
    return paymentView(row);
  }

  /**
   * What recording and voiding answer (code review, m5): those permissions do not include seeing costs, so no amounts,
   * no cost descriptions and no reference. The full payment is `get`, behind `suppliers.cost.read`.
   */
  private async outcomeView(id: string): Promise<SupplierPaymentOutcome> {
    const row = await this.prisma.supplierPayment.findFirst({ where: { id, mode: this.ledger.mode }, select: { id: true, supplierId: true, mode: true, status: true, version: true, paidOn: true, _count: { select: { items: true } } } });
    if (!row) throw notFound('supplier_payment_not_found', 'Supplier payment not found');
    return { id: row.id, supplierId: row.supplierId, mode: row.mode, status: row.status, version: row.version, paidOn: fromDate(row.paidOn)!, items: row._count.items };
  }

  async listForSupplier(supplierId: string): Promise<{ items: SupplierPaymentView[] }> {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, deletedAt: null }, select: { id: true } });
    if (!supplier) throw notFound('supplier_not_found', 'Supplier not found');
    // Only the environment's mode (plan 0.1, P11).
    const rows = await this.prisma.supplierPayment.findMany({ where: { supplierId, mode: this.ledger.mode }, orderBy: [{ paidOn: 'desc' }, { recordedAt: 'desc' }], select: PAYMENT_SELECT });
    return { items: rows.map(paymentView) };
  }

  /** What recording these cost items would come to, from the server (the panel never adds amounts). Writes nothing. */
  async preview(supplierId: string, input: PreviewInput): Promise<{ supplierId: string; amountMinor: string; currency: string; costItemIds: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertSupplier(tx, supplierId);
      const costs = await this.lockCosts(tx, input.items.map((i) => i.costItemId), 'none');
      const { amountMinor, currency } = this.check(supplierId, input.items, costs);
      return { supplierId, amountMinor: amountMinor.toString(), currency, costItemIds: costs.map((c) => c.id) };
    });
  }

  /**
   * Records a payment already made (section 4.2). Idempotent twice over (plan review, point 1): the HTTP record, and the
   * business key looked up inside the transaction, so a retry after the HTTP record was lost returns the same payment.
   */
  async record(actor: Actor, supplierId: string, input: RecordInput, clientKey: string, now: Date = new Date()): Promise<{ status: number; payment: SupplierPaymentOutcome }> {
    this.checkPaidOn(input.paidOn, now);
    const outcome = await this.idempotency.run(
      { actorType: 'staff', actorId: actor.id, route: RECORD_ROUTE, key: clientKey, body: { supplierId, ...input } },
      async () => {
        const r = await this.recordOnce(actor, supplierId, input, supplierPaymentKey(actor.id, clientKey));
        return { status: r.created ? 201 : 200, resourceType: 'SupplierPayment', resourceId: r.id };
      },
      now,
    ).catch((err: unknown) => { throw asApiError(err); });
    return { status: outcome.result.status, payment: await this.outcomeView(outcome.result.resourceId!) };
  }

  /** Voids a payment recorded by mistake (section 4.4). The same void again (same person, same reason) returns it. */
  async voidPayment(actor: Actor, id: string, input: VoidInput, clientKey: string, now: Date = new Date()): Promise<SupplierPaymentOutcome> {
    const outcome = await this.idempotency.run(
      { actorType: 'staff', actorId: actor.id, route: VOID_ROUTE, key: clientKey, body: { id, ...input } },
      async () => {
        await this.voidOnce(actor, id, input, now);
        return { status: 200, resourceType: 'SupplierPayment', resourceId: id };
      },
      now,
    ).catch((err: unknown) => { throw asApiError(err); });
    return this.outcomeView(outcome.result.resourceId!);
  }

  // ---- Internals ----

  private checkPaidOn(paidOn: string, now: Date): void {
    const today = todayInBrisbane(now);
    if (paidOn > today) throw unprocessable('paid_on_in_future', 'The date paid cannot be after today');
    if (paidOn < addDays(today, -PAID_ON_MAX_AGE_DAYS)) throw unprocessable('paid_on_too_old', 'The date paid is more than a year ago');
  }

  private async assertSupplier(tx: Tx, supplierId: string): Promise<void> {
    const s = await tx.supplier.findFirst({ where: { id: supplierId, deletedAt: null }, select: { id: true } });
    if (!s) throw notFound('supplier_not_found', 'Supplier not found');
  }

  /** The cost items in ascending id order (plan 0.1, 6.3), locked for a write; the preview only reads (code review, m4). */
  private lockCosts(tx: Tx, ids: string[], lock: 'FOR UPDATE' | 'none'): Promise<LockedCost[]> {
    const sorted = [...new Set(ids)].sort();
    return lock === 'FOR UPDATE'
      ? tx.$queryRaw<LockedCost[]>`SELECT id::text AS id, "supplierId"::text AS "supplierId", status::text AS status, version, "amountMinor", currency FROM cost_items WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`
      : tx.$queryRaw<LockedCost[]>`SELECT id::text AS id, "supplierId"::text AS "supplierId", status::text AS status, version, "amountMinor", currency FROM cost_items WHERE id = ANY(${sorted}::uuid[]) ORDER BY id`;
  }

  /** The checks of section 4.2, step 2, in a fixed order; the amount is the sum of the locked rows. */
  private check(supplierId: string, items: ReadonlyArray<{ costItemId: string; version: number }>, costs: LockedCost[]): { amountMinor: bigint; currency: string } {
    if (costs.length !== new Set(items.map((i) => i.costItemId)).size) throw notFound('cost_item_not_found', 'Cost item not found');
    if (costs.some((c) => c.supplierId !== supplierId)) throw unprocessable('cost_item_supplier_mismatch', 'A cost item belongs to another supplier');
    const currencies = new Set(costs.map((c) => c.currency));
    if (currencies.size !== 1) throw unprocessable('cost_items_currency_mismatch', 'Record one payment per currency');
    if (costs.some((c) => c.status === 'paid')) throw conflict('cost_item_already_paid', 'A cost item is already paid');
    if (costs.some((c) => c.status !== 'planned' && c.status !== 'due')) throw conflict('cost_item_not_payable', 'A cost item is no longer owed');
    // A cost of 0 is owed nothing (6.1 allows it; a payment line is always above 0): it is never paid (code review, M1).
    if (costs.some((c) => c.amountMinor === 0n)) throw unprocessable('cost_item_zero_amount', 'A cost item of 0 is not paid: set its amount or call it off');
    const version = new Map(items.map((i) => [i.costItemId, i.version]));
    if (costs.some((c) => version.get(c.id) !== c.version)) throw versionConflict();
    return { amountMinor: costs.reduce((s, c) => s + c.amountMinor, 0n), currency: [...currencies][0]! };
  }

  private async byKey(db: Tx, key: string) {
    return db.supplierPayment.findUnique({ where: { idempotencyKey: key }, select: { id: true, supplierId: true, paidOn: true, reference: true, baseAmountMinor: true, baseCurrency: true, items: { select: { costItemId: true } } } });
  }

  /** A retry of the same recording returns it; other content under the same key is refused (plan review, point 1). */
  private replay(existing: NonNullable<Awaited<ReturnType<SupplierPaymentService['byKey']>>>, supplierId: string, input: RecordInput): { id: string; created: false } {
    const ids = (xs: string[]) => [...xs].sort().join(',');
    const same = existing.supplierId === supplierId
      && ids(existing.items.map((i) => i.costItemId)) === ids(input.items.map((i) => i.costItemId))
      && fromDate(existing.paidOn) === input.paidOn
      && existing.reference === input.reference
      && (existing.baseAmountMinor?.toString() ?? null) === (input.base?.amountMinor ?? null)
      && (existing.baseCurrency ?? null) === (input.base?.currency ?? null);
    if (!same) throw keyReused();
    return { id: existing.id, created: false };
  }

  private async recordOnce(actor: Actor, supplierId: string, input: RecordInput, key: string): Promise<{ id: string; created: boolean }> {
    try {
      return await runTransaction(this.prisma, async (tx) => {
        await this.assertSupplier(tx, supplierId);
        const costs = await this.lockCosts(tx, input.items.map((i) => i.costItemId), 'FOR UPDATE');
        const existing = await this.byKey(tx, key);
        if (existing) return this.replay(existing, supplierId, input);
        const { amountMinor, currency } = this.check(supplierId, input.items, costs);
        if (input.base && input.base.currency === currency) throw unprocessable('base_currency_same_as_payment', 'The amount your bank debited is only needed when it was in another currency');
        const mode = this.ledger.mode;
        const payment = await tx.supplierPayment.create({
          data: {
            supplierId, mode, amountMinor, currency, baseAmountMinor: input.base ? BigInt(input.base.amountMinor) : null, baseCurrency: input.base?.currency ?? null,
            paidOn: toDate(input.paidOn), reference: input.reference, idempotencyKey: key, recordedById: actor.id,
          },
          select: { id: true, mode: true, amountMinor: true, currency: true, baseAmountMinor: true, baseCurrency: true, version: true },
        });
        await tx.supplierPaymentItem.createMany({ data: costs.map((c) => ({ supplierPaymentId: payment.id, mode, costItemId: c.id, amountMinor: c.amountMinor, currency })) });
        const version = new Map(input.items.map((i) => [i.costItemId, i.version]));
        for (const c of costs) {
          const res = await tx.costItem.updateMany({ where: { id: c.id, version: version.get(c.id)!, status: { in: ['planned', 'due'] } }, data: { status: 'paid', version: { increment: 1 } } });
          if (res.count !== 1) throw versionConflict();
        }
        await this.ledger.postRecorded(tx, ref(payment));
        // No reference and no cost description in the audit trail or the event (plan 6.2, section 8).
        await this.audit.record(tx, {
          actor, action: 'suppliers.payment.recorded', entityType: 'SupplierPayment', entityId: payment.id,
          after: { supplierId, mode, amountMinor, currency, baseAmountMinor: payment.baseAmountMinor, baseCurrency: payment.baseCurrency, paidOn: input.paidOn, status: 'recorded' },
          context: { items: costs.length },
        });
        await this.outbox.publish(tx, {
          type: SUPPLIER_PAYMENT_EVENTS.recorded, aggregateType: 'SupplierPayment', aggregateId: payment.id, aggregateVersion: payment.version,
          payload: { supplierPaymentId: payment.id, supplierId, costItemIds: costs.map((c) => c.id), mode }, actorType: actor.type, actorId: actor.id,
        });
        await this.closeAlerts(tx, costs.map((c) => c.id));
        return { id: payment.id, created: true };
      });
    } catch (err) {
      // Two retries racing (plan review, point 1): the business key decides; otherwise the live-item index did.
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.byKey(this.prisma, key);
      if (existing) return this.replay(existing, supplierId, input);
      throw conflict('cost_item_already_paid', 'A cost item is already paid');
    }
  }

  private async voidOnce(actor: Actor, id: string, input: VoidInput, now: Date): Promise<void> {
    await runTransaction(this.prisma, async (tx) => {
      // Only a payment of the environment's mode (code review, m6).
      const head = await tx.supplierPayment.findFirst({ where: { id, mode: this.ledger.mode }, select: { items: { select: { costItemId: true } } } });
      if (!head) throw notFound('supplier_payment_not_found', 'Supplier payment not found');
      const costIds = head.items.map((i) => i.costItemId);
      await this.lockCosts(tx, costIds, 'FOR UPDATE');
      const rows = await tx.$queryRaw<Array<{ status: string; version: number; voidedById: string | null; voidReason: string | null }>>`
        SELECT status::text AS status, version, "voidedById"::text AS "voidedById", "voidReason" FROM supplier_payments WHERE id = ${id}::uuid FOR UPDATE`;
      const p = rows[0]!;
      if (p.status === 'voided') {
        // A retry of this very void after its HTTP record was lost (plan review, point 1).
        if (p.voidedById === actor.id && p.voidReason === input.reason) return;
        throw conflict('supplier_payment_already_voided', 'This supplier payment is already voided');
      }
      if (p.version !== input.version) throw versionConflict();
      const res = await tx.supplierPayment.updateMany({
        where: { id, status: 'recorded', version: input.version },
        data: { status: 'voided', voidedAt: now, voidedById: actor.id, voidReason: input.reason, version: { increment: 1 } },
      });
      if (res.count !== 1) throw versionConflict();
      await tx.supplierPaymentItem.updateMany({ where: { supplierPaymentId: id, active: true }, data: { active: false } });
      for (const costId of [...costIds].sort()) {
        // Still owed: back to due (decision D5).
        const freed = await tx.costItem.updateMany({ where: { id: costId, status: 'paid' }, data: { status: 'due', version: { increment: 1 } } });
        if (freed.count !== 1) throw new AppError('supplier_payment_cost_not_paid', 'A cost item of this payment is not marked paid');
      }
      const after = await tx.supplierPayment.findUniqueOrThrow({ where: { id }, select: { id: true, mode: true, amountMinor: true, currency: true, baseAmountMinor: true, baseCurrency: true, version: true, supplierId: true } });
      await this.ledger.postVoided(tx, ref(after));
      // The reason is personal data: the audit service keeps it apart from the change log.
      await this.audit.record(tx, {
        actor, action: 'suppliers.payment.voided', entityType: 'SupplierPayment', entityId: id, reason: input.reason,
        before: { status: 'recorded' }, after: { status: 'voided' }, context: { items: costIds.length },
      });
      await this.outbox.publish(tx, {
        type: SUPPLIER_PAYMENT_EVENTS.voided, aggregateType: 'SupplierPayment', aggregateId: id, aggregateVersion: after.version,
        payload: { supplierPaymentId: id, supplierId: after.supplierId, costItemIds: costIds, mode: after.mode }, actorType: actor.type, actorId: actor.id,
      });
    });
  }

  /** Closes the open alert tasks of cost items that were just paid. */
  private async closeAlerts(tx: Tx, costItemIds: string[]): Promise<void> {
    const prefixes = costItemIds.flatMap(alertRefPrefixes);
    const open = await tx.task.findMany({ where: { source: 'system', status: 'open', deletedAt: null, OR: prefixes.map((p) => ({ sourceRef: { startsWith: p } })) }, select: { sourceRef: true } });
    for (const t of open) if (t.sourceRef) await this.tasks.closeSystemIn(tx, t.sourceRef);
  }
}
