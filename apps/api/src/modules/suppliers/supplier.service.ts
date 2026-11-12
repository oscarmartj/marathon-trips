import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type {
  createContactSchema, createContractSchema, createSupplierSchema, supplierQuerySchema, updateContactSchema, updateContractSchema, updateSupplierSchema,
} from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { CustomFieldsService } from '../../platform/common/custom-fields/custom-fields.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { Tx, assertVersion, defined, orConflict, toDate, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };
const dates = ['signedAt', 'validFrom', 'validTo'] as const;
const withDates = <T extends Record<string, unknown>>(o: T): T => {
  const out: Record<string, unknown> = { ...o };
  for (const k of dates) if (typeof out[k] === 'string') out[k] = toDate(out[k] as string);
  return out as T;
};

/** Suppliers, their contacts and their contracts (plan 5.7). Costs and allotments live in their own services. */
@Injectable()
export class SupplierService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
  ) {}

  async list(q: z.infer<typeof supplierQuerySchema>) {
    const cf = await this.customFields.filterWhere('Supplier', q.cf);
    const where: Prisma.SupplierWhereInput = {
      deletedAt: null,
      ...(cf.length ? { AND: cf as Prisma.SupplierWhereInput[] } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.supplier.count({ where }),
      this.prisma.supplier.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return view({ items: rows, page: q.page, pageSize: q.pageSize, total });
  }

  async get(id: string) {
    const s = await this.prisma.supplier.findFirst({
      where: { id, deletedAt: null },
      include: { contacts: { orderBy: { createdAt: 'asc' } }, contracts: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
    });
    if (!s) throw notFound('supplier_not_found', 'Supplier not found');
    return view(s);
  }

  async create(actor: Actor, input: z.infer<typeof createSupplierSchema>) {
    const { reason, customFields, ...data } = input;
    const row = await this.prisma.$transaction(async (tx) => {
      const customValues = await this.customFields.forWrite(tx, 'Supplier', customFields, null, true);
      const created = await tx.supplier.create({ data: { ...data, customFields: customValues, isDemo: false } });
      await this.audit.record(tx, { actor, action: 'suppliers.supplier.created', entityType: 'Supplier', entityId: created.id, reason, after: view(created) });
      return created;
    });
    return this.get(row.id);
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateSupplierSchema>) {
    const { version, reason, customFields, ...rest } = input;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.supplier.findFirst({ where: { id, deletedAt: null } });
      assertVersion(before, version, 'Supplier not found');
      const customValues = await this.customFields.forWrite(tx, 'Supplier', customFields, before.customFields, false);
      const res = await tx.supplier.updateMany({ where: { id, version, deletedAt: null }, data: { ...defined(rest), ...(customValues ? { customFields: customValues } : {}), version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.supplier.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action: 'suppliers.supplier.updated', entityType: 'Supplier', entityId: id, reason, before: view(before), after: view(after) });
    });
    return this.get(id);
  }

  /** Soft delete. A supplier with live contracts or cost items that are not cancelled stays (409). */
  async remove(actor: Actor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM suppliers WHERE id = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (rows.length === 0) throw notFound('supplier_not_found', 'Supplier not found');
      if ((await tx.supplierContract.count({ where: { supplierId: id, deletedAt: null } })) > 0) throw conflict('supplier_has_contracts', 'Delete the contracts first');
      if ((await tx.costItem.count({ where: { supplierId: id, status: { not: 'cancelled' } } })) > 0) throw conflict('supplier_has_costs', 'Cancel the cost items first');
      await tx.supplier.update({ where: { id }, data: { deletedAt: new Date(), deletedById: actor.id, version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'suppliers.supplier.deleted', entityType: 'Supplier', entityId: id, reason, before: { deletedAt: null }, after: { deletedAt: new Date() } });
    });
  }

  // ---- Contacts ----

  async addContact(actor: Actor, supplierId: string, input: z.infer<typeof createContactSchema>) {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.liveSupplier(tx, supplierId);
      const c = await tx.supplierContact.create({ data: { ...input, supplierId } });
      await this.audit.record(tx, { actor, action: 'suppliers.contact.created', entityType: 'SupplierContact', entityId: c.id, after: view(c) });
      return c;
    });
    return view(row);
  }

  async updateContact(actor: Actor, id: string, input: z.infer<typeof updateContactSchema>) {
    return view(
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.supplierContact.findFirst({ where: { id, supplier: { deletedAt: null } } });
        if (!before) throw notFound('contact_not_found', 'Contact not found');
        const after = await tx.supplierContact.update({ where: { id }, data: defined(input) });
        await this.audit.record(tx, { actor, action: 'suppliers.contact.updated', entityType: 'SupplierContact', entityId: id, before: view(before), after: view(after) });
        return after;
      }),
    );
  }

  /** A contact is a person at the supplier, not customer data: deleting it really deletes the row (audit keeps the fact). */
  async removeContact(actor: Actor, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.supplierContact.findFirst({ where: { id, supplier: { deletedAt: null } } });
      if (!before) throw notFound('contact_not_found', 'Contact not found');
      await tx.supplierContact.delete({ where: { id } });
      await this.audit.record(tx, { actor, action: 'suppliers.contact.deleted', entityType: 'SupplierContact', entityId: id, before: view(before) });
    });
  }

  // ---- Contracts ----

  async listContracts(supplierId: string) {
    await this.liveSupplier(this.prisma, supplierId);
    return view(await this.prisma.supplierContract.findMany({ where: { supplierId, deletedAt: null }, orderBy: { createdAt: 'asc' } }));
  }

  async addContract(actor: Actor, supplierId: string, input: z.infer<typeof createContractSchema>) {
    const { reason, ...data } = input;
    return view(
      await orConflict('contract_reference_taken', 'This supplier already has a contract with this reference', () =>
        this.prisma.$transaction(async (tx) => {
          await this.liveSupplier(tx, supplierId, true);
          if (data.editionId) await this.liveEdition(tx, data.editionId);
          const c = await tx.supplierContract.create({ data: { ...withDates(data), supplierId } });
          await this.audit.record(tx, { actor, action: 'suppliers.contract.created', entityType: 'SupplierContract', entityId: c.id, reason, after: view(c) });
          return c;
        }),
      ),
    );
  }

  async updateContract(actor: Actor, id: string, input: z.infer<typeof updateContractSchema>) {
    const { version, reason, ...rest } = input;
    return view(
      await orConflict('contract_reference_taken', 'This supplier already has a contract with this reference', () =>
        this.prisma.$transaction(async (tx) => {
          const before = await tx.supplierContract.findFirst({ where: { id, deletedAt: null } });
          assertVersion(before, version, 'Contract not found');
          const merged = { validFrom: rest.validFrom !== undefined ? rest.validFrom : before.validFrom?.toISOString().slice(0, 10) ?? null, validTo: rest.validTo !== undefined ? rest.validTo : before.validTo?.toISOString().slice(0, 10) ?? null };
          if (merged.validFrom && merged.validTo && merged.validFrom > merged.validTo) throw conflict('contract_dates_invalid', 'validFrom must not be after validTo');
          if (rest.editionId) {
            await this.liveEdition(tx, rest.editionId);
            if (rest.editionId !== before.editionId) {
              const clash = await tx.allotment.count({ where: { contractId: id, pool: { editionId: { not: rest.editionId } } } });
              if (clash > 0) throw conflict('contract_edition_mismatch', 'Some allotments of this contract are for another edition');
            }
          }
          const res = await tx.supplierContract.updateMany({ where: { id, version, deletedAt: null }, data: { ...withDates(defined(rest)), version: { increment: 1 } } });
          if (res.count !== 1) throw versionConflict();
          const after = await tx.supplierContract.findUniqueOrThrow({ where: { id } });
          await this.audit.record(tx, { actor, action: 'suppliers.contract.updated', entityType: 'SupplierContract', entityId: id, reason, before: view(before), after: view(after) });
          return after;
        }),
      ),
    );
  }

  async removeContract(actor: Actor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM supplier_contracts WHERE id = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (rows.length === 0) throw notFound('contract_not_found', 'Contract not found');
      if ((await tx.allotment.count({ where: { contractId: id } })) > 0) throw conflict('contract_has_allotments', 'Delete or move the allotments first');
      if ((await tx.costItem.count({ where: { contractId: id, status: { not: 'cancelled' } } })) > 0) throw conflict('contract_has_costs', 'Cancel the cost items first');
      await tx.supplierContract.update({ where: { id }, data: { deletedAt: new Date(), deletedById: actor.id, version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'suppliers.contract.deleted', entityType: 'SupplierContract', entityId: id, reason, before: { deletedAt: null }, after: { deletedAt: new Date() } });
    });
  }

  // ---- helpers ----

  /** 404 unless the supplier is live. `lock` takes a share lock so a delete cannot slip in between. */
  private async liveSupplier(db: Tx | PrismaService, id: string, lock = false): Promise<void> {
    const rows = lock
      ? await (db as Tx).$queryRaw<Array<{ id: string }>>`SELECT id FROM suppliers WHERE id = ${id}::uuid AND "deletedAt" IS NULL FOR SHARE`
      : await db.supplier.findMany({ where: { id, deletedAt: null }, select: { id: true } });
    if (rows.length === 0) throw notFound('supplier_not_found', 'Supplier not found');
  }

  private async liveEdition(tx: Tx, id: string): Promise<void> {
    const e = await tx.raceEdition.findFirst({ where: { id, race: { deletedAt: null } }, select: { id: true } });
    if (!e) throw notFound('edition_not_found', 'Edition not found');
  }
}
