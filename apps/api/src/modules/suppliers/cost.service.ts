import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { createCostSchema, costStatusSchema, updateCostSchema } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { Tx, assertVersion, defined, toDate, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };

/** What a status can move to by hand. `paid` is reached only through supplier payments (task 6.2). */
export const COST_TRANSITIONS: Record<string, readonly string[]> = {
  planned: ['due', 'cancelled'],
  due: ['planned', 'cancelled'],
  paid: [],
  cancelled: [],
};

/** Quantity times unit amount, in minor units. The only place a cost amount is worked out. */
export const costAmount = (quantity: number, unitAmountMinor: bigint): bigint => BigInt(quantity) * unitAmountMinor;

/** Supplier cost prices in the supplier's own currency (plan 5.7). Records only: nothing here pays or converts. */
@Injectable()
export class CostService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listForSupplier(supplierId: string) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, deletedAt: null }, select: { id: true } });
    if (!supplier) throw notFound('supplier_not_found', 'Supplier not found');
    const items = await this.prisma.costItem.findMany({ where: { supplierId }, orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }] });
    // Totals per currency and status, never across currencies. Cancelled items are not counted.
    const totals = new Map<string, bigint>();
    for (const c of items.filter((i) => i.status !== 'cancelled')) {
      const key = `${c.currency}|${c.status}`;
      totals.set(key, (totals.get(key) ?? 0n) + c.amountMinor);
    }
    const summary = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ currency: k.split('|')[0]!, status: k.split('|')[1]!, amountMinor: v.toString() }));
    return view({ items, summary });
  }

  async create(actor: Actor, supplierId: string, input: z.infer<typeof createCostSchema>) {
    const { reason, unitAmountMinor, dueDate, ...rest } = input;
    if (rest.basis === 'fixed' && rest.quantity !== 1) throw unprocessable('fixed_cost_quantity', 'A fixed cost has a quantity of 1');
    const unit = BigInt(unitAmountMinor);
    return view(
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM suppliers WHERE id = ${supplierId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
        if (rows.length === 0) throw notFound('supplier_not_found', 'Supplier not found');
        await this.checkLinks(tx, supplierId, rest.contractId, rest.packageId);
        const row = await tx.costItem.create({ data: { ...rest, supplierId, unitAmountMinor: unit, amountMinor: costAmount(rest.quantity, unit), dueDate: dueDate ? toDate(dueDate) : null } });
        await this.audit.record(tx, { actor, action: 'suppliers.cost.created', entityType: 'CostItem', entityId: row.id, reason, after: view(row) });
        return row;
      }),
    );
  }

  /** Only a planned or due item can change; the amount is worked out again from the merged quantity and unit amount. */
  async update(actor: Actor, id: string, input: z.infer<typeof updateCostSchema>) {
    const { version, reason, unitAmountMinor, dueDate, ...rest } = input;
    return view(
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.costItem.findUnique({ where: { id } });
        assertVersion(before, version, 'Cost item not found');
        if (before.status !== 'planned' && before.status !== 'due') throw conflict('cost_not_editable', 'A paid or cancelled cost item cannot be changed');
        const quantity = rest.quantity ?? before.quantity;
        const unit = unitAmountMinor !== undefined ? BigInt(unitAmountMinor) : before.unitAmountMinor;
        const basis = rest.basis ?? before.basis;
        if (basis === 'fixed' && quantity !== 1) throw unprocessable('fixed_cost_quantity', 'A fixed cost has a quantity of 1');
        await this.checkLinks(tx, before.supplierId, rest.contractId === undefined ? before.contractId : rest.contractId, rest.packageId === undefined ? before.packageId : rest.packageId);
        const res = await tx.costItem.updateMany({
          where: { id, version, status: { in: ['planned', 'due'] } },
          data: { ...defined(rest), unitAmountMinor: unit, amountMinor: costAmount(quantity, unit), ...(dueDate !== undefined ? { dueDate: dueDate ? toDate(dueDate) : null } : {}), version: { increment: 1 } },
        });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.costItem.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'suppliers.cost.updated', entityType: 'CostItem', entityId: id, reason, before: view(before), after: view(after) });
        return after;
      }),
    );
  }

  async setStatus(actor: Actor, id: string, input: z.infer<typeof costStatusSchema>) {
    return view(
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.costItem.findUnique({ where: { id } });
        assertVersion(before, input.version, 'Cost item not found');
        if (!COST_TRANSITIONS[before.status]!.includes(input.status)) throw conflict('transition_not_allowed', 'This status change is not allowed');
        const res = await tx.costItem.updateMany({ where: { id, version: input.version, status: before.status }, data: { status: input.status, version: { increment: 1 } } });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.costItem.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'suppliers.cost.status_changed', entityType: 'CostItem', entityId: id, reason: input.reason, before: { status: before.status }, after: { status: after.status } });
        return after;
      }),
    );
  }

  private async checkLinks(tx: Tx, supplierId: string, contractId: string | null, packageId: string | null): Promise<void> {
    if (contractId) {
      const c = await tx.supplierContract.findFirst({ where: { id: contractId, deletedAt: null }, select: { supplierId: true } });
      if (!c) throw notFound('contract_not_found', 'Contract not found');
      if (c.supplierId !== supplierId) throw unprocessable('contract_supplier_mismatch', 'The contract belongs to another supplier');
    }
    if (packageId) {
      const p = await tx.package.findFirst({ where: { id: packageId, deletedAt: null }, select: { id: true } });
      if (!p) throw notFound('package_not_found', 'Package not found');
    }
  }
}
