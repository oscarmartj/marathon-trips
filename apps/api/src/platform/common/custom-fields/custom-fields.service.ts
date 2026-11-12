import { Inject, Injectable } from '@nestjs/common';
import {
  definitionProblem,
  type CreateCustomFieldInput, type CustomFieldDefinitionView, type CustomFieldEntity, type CustomFieldOption, type CustomFieldValidation, type CustomFilter,
  type UpdateCustomFieldInput,
} from '@mt/shared';
import { AccessService } from '../../access/access.service';
import type { AuthContext } from '../../access/auth-context';
import { COMMON_PERMISSIONS_KEYS as K } from '../permissions';
import { Prisma } from '../../../generated/prisma/client';
import type { AuditActor } from '../../audit/audit.service';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { conflict, notFound, unprocessable } from '../../http/api-error';
import { filterCondition, fromCsvCell, isBlank, ownValue, toCsvCell, validateValue, type CustomValue, type JsonCondition, type RuleDef } from './values';

type Actor = AuditActor & { id: string };
type Db = Pick<Prisma.TransactionClient, 'customFieldDefinition'>;
type Row = Prisma.CustomFieldDefinitionGetPayload<object>;

/**
 * What each kind of record allows. Adding Customer, Traveller or Booking later is one line here plus the `customFields`
 * column on the table. Customers cannot see supplier data and cannot edit catalogue records, so those flags are refused.
 */
export const CUSTOM_FIELD_TARGETS: Record<CustomFieldEntity, { customerVisible: boolean; customerEditable: boolean; table: string }> = {
  Race: { customerVisible: true, customerEditable: false, table: 'races' },
  Package: { customerVisible: true, customerEditable: false, table: 'packages' },
  Supplier: { customerVisible: false, customerEditable: false, table: 'suppliers' },
};

const PLAIN = (v: Prisma.JsonValue | null): unknown => v;

export const definitionView = (r: Row): CustomFieldDefinitionView => ({
  id: r.id, entityType: r.entityType as CustomFieldEntity, key: r.key, label: r.label as Record<string, string>, type: r.type,
  options: (PLAIN(r.options) as CustomFieldOption[] | null) ?? null, validation: (PLAIN(r.validation) as CustomFieldValidation | null) ?? null,
  required: r.required, visibleToCustomer: r.visibleToCustomer, editableByCustomer: r.editableByCustomer, displayOrder: r.displayOrder,
  archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null, version: r.version,
});

const ruleOf = (r: Row): RuleDef => ({ key: r.key, type: r.type, options: (r.options as CustomFieldOption[] | null) ?? null, validation: (r.validation as CustomFieldValidation | null) ?? null, required: r.required });

const bad = (r: Row, code: string) => unprocessable('custom_field_invalid', `Custom field ${r.key} is not valid (${code})`);

export interface PublicCustomField {
  key: string;
  label: Record<string, string>;
  type: Row['type'];
  value: CustomValue;
  /** For select fields: the chosen options with their labels. */
  options?: Array<{ value: string; label: Record<string, string> }>;
}

/** Custom field definitions and the rules that apply their values to records (task 7.5). */
@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  // ---- Definitions ----

  async list(query: { entityType?: CustomFieldEntity; includeArchived: boolean }) {
    const rows = await this.prisma.customFieldDefinition.findMany({
      where: { ...(query.entityType ? { entityType: query.entityType } : {}), ...(query.includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ entityType: 'asc' }, { displayOrder: 'asc' }, { key: 'asc' }],
    });
    return { items: rows.map(definitionView) };
  }

  /** The fields a form, a filter bar or an export offers for one kind of record: active ones in display order. */
  async activeFor(entityType: CustomFieldEntity, db: Db = this.prisma): Promise<CustomFieldDefinitionView[]> {
    return (await this.activeRows(entityType, db)).map(definitionView);
  }

  private activeRows(entityType: string, db: Db): Promise<Row[]> {
    return db.customFieldDefinition.findMany({ where: { entityType, archivedAt: null }, orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }] });
  }

  private checkFlags(entityType: CustomFieldEntity, f: { visibleToCustomer: boolean; editableByCustomer: boolean }): void {
    const target = CUSTOM_FIELD_TARGETS[entityType];
    if (f.visibleToCustomer && !target.customerVisible) throw unprocessable('custom_field_not_customer_visible', 'Customers cannot see this kind of record, so the field cannot be visible to them');
    if (f.editableByCustomer && !target.customerEditable) throw unprocessable('custom_field_not_customer_editable', 'Customers cannot edit this kind of record, so the field cannot be editable by them');
    if (f.editableByCustomer && !f.visibleToCustomer) throw unprocessable('custom_field_not_visible', 'A field the customer edits must be visible to them');
  }

  async create(actor: Actor, input: CreateCustomFieldInput) {
    const { reason, ...data } = input;
    this.checkFlags(data.entityType, data);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.customFieldDefinition.create({
          data: { ...data, options: (data.options ?? Prisma.DbNull) as Prisma.InputJsonValue, validation: (data.validation ?? Prisma.DbNull) as Prisma.InputJsonValue },
        });
        await this.audit.record(tx, { actor, action: 'common.custom_field.created', entityType: 'CustomFieldDefinition', entityId: created.id, reason, after: definitionView(created) as unknown as Record<string, unknown> });
        return created;
      });
      return definitionView(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('custom_field_key_taken', 'This record type already has a custom field with that key');
      throw err;
    }
  }

  /**
   * Turning on `visibleToCustomer` shows every value already stored on records, some written when the field was internal.
   * So it needs its own permission with a recent authenticator check (M12), on top of manage. Creating a visible field does
   * not (no record holds a value yet), and a field that was already visible changes nothing.
   */
  private async assertMayPublish(auth: AuthContext): Promise<void> {
    await this.access.assertPermission(this.prisma, auth, K.customFieldPublish);
  }

  /** How many records hold a value for a field: what making it visible would show. Counts, never values. */
  async usage(id: string): Promise<{ records: number }> {
    const def = await this.prisma.customFieldDefinition.findUnique({ where: { id } });
    if (!def) throw notFound('custom_field_not_found', 'Custom field not found');
    const table = CUSTOM_FIELD_TARGETS[def.entityType as CustomFieldEntity].table;
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT count(*) AS n FROM ${Prisma.raw(`"${table}"`)} WHERE jsonb_exists("customFields", ${def.key})`);
    return { records: Number(rows[0]?.n ?? 0) };
  }

  async update(actor: Actor, auth: AuthContext, id: string, input: UpdateCustomFieldInput) {
    const { version, reason, ...patch } = input;
    if (patch.visibleToCustomer === true) {
      const current = await this.prisma.customFieldDefinition.findUnique({ where: { id }, select: { visibleToCustomer: true } });
      if (current && !current.visibleToCustomer) await this.assertMayPublish(auth);
    }
    return this.change(actor, id, version, reason, 'common.custom_field.updated', (before) => {
      const next = { required: patch.required ?? before.required, visibleToCustomer: patch.visibleToCustomer ?? before.visibleToCustomer, editableByCustomer: patch.editableByCustomer ?? before.editableByCustomer };
      this.checkFlags(before.entityType as CustomFieldEntity, next);
      const options = patch.options ?? (before.options as CustomFieldOption[] | null) ?? undefined;
      const validation = patch.validation ?? (before.validation as CustomFieldValidation | null) ?? undefined;
      const problem = definitionProblem(before.type, options, validation);
      if (problem) throw unprocessable('custom_field_definition_invalid', problem);
      if (patch.options) {
        const kept = new Set(patch.options.map((o) => o.value));
        for (const o of (before.options as CustomFieldOption[] | null) ?? []) if (!kept.has(o.value)) throw unprocessable('option_cannot_be_removed', 'An option cannot be removed; retire it instead');
      }
      return {
        ...(patch.label ? { label: patch.label } : {}), ...(patch.options ? { options: patch.options as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.validation ? { validation: patch.validation as Prisma.InputJsonValue } : {}), ...next,
        ...(patch.displayOrder !== undefined ? { displayOrder: patch.displayOrder } : {}),
      };
    });
  }

  archive(actor: Actor, id: string, input: { version: number; reason?: string }) {
    return this.change(actor, id, input.version, input.reason, 'common.custom_field.archived', (before) => {
      if (before.archivedAt) throw conflict('custom_field_already_archived', 'This custom field is already archived');
      return { archivedAt: new Date() };
    });
  }

  async restore(actor: Actor, auth: AuthContext, id: string, input: { version: number; reason?: string }) {
    const current = await this.prisma.customFieldDefinition.findUnique({ where: { id }, select: { visibleToCustomer: true, archivedAt: true } });
    if (current?.visibleToCustomer && current.archivedAt) await this.assertMayPublish(auth);
    return this.change(actor, id, input.version, input.reason, 'common.custom_field.restored', (before) => {
      if (!before.archivedAt) throw conflict('custom_field_not_archived', 'This custom field is not archived');
      return { archivedAt: null };
    });
  }

  private async change(actor: Actor, id: string, version: number, reason: string | undefined, action: string, build: (before: Row) => Prisma.CustomFieldDefinitionUpdateManyMutationInput) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.customFieldDefinition.findUnique({ where: { id } });
      if (!before) throw notFound('custom_field_not_found', 'Custom field not found');
      if (before.version !== version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      const res = await tx.customFieldDefinition.updateMany({ where: { id, version }, data: { ...build(before), version: { increment: 1 } } });
      if (res.count !== 1) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      const after = await tx.customFieldDefinition.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action, entityType: 'CustomFieldDefinition', entityId: id, reason, before: definitionView(before) as unknown as Record<string, unknown>, after: definitionView(after) as unknown as Record<string, unknown> });
      return definitionView(after);
    });
  }

  // ---- Values on records ----

  /**
   * The `customFields` object to store for a create or an update, checked against the active definitions. Run it in the
   * caller's transaction. Returns `undefined` when an update carries no custom fields (leave the column alone).
   * A key is merged in; `null` or a blank value removes it; values of archived fields are kept untouched.
   * `required` is enforced on create and when a patch tries to clear the field, never on records that predate the field.
   */
  async forWrite(db: Db, entityType: CustomFieldEntity, patch: Record<string, unknown> | undefined, existing: unknown, creating: boolean): Promise<Prisma.InputJsonObject | undefined> {
    if (patch === undefined && !creating) return undefined;
    const defs = await this.activeRows(entityType, db);
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const merged: Record<string, unknown> = { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {}) };
    for (const [key, raw] of Object.entries(patch ?? {})) {
      const def = byKey.get(key);
      if (!def) throw unprocessable('custom_field_unknown', 'That custom field does not exist for this record');
      if (isBlank(raw)) {
        if (def.required) throw bad(def, 'required');
        delete merged[key];
        continue;
      }
      const res = validateValue(ruleOf(def), raw, ownValue(merged, key));
      if (!res.ok) throw bad(def, res.code);
      merged[key] = res.value;
    }
    if (creating) for (const d of defs) if (d.required && isBlank(ownValue(merged, d.key))) throw bad(d, 'required');
    return merged as Prisma.InputJsonObject;
  }

  /** Conditions for a list's `cf` filters, ready to go in an `AND`. 422 for an unknown or archived field, an operator that does not fit or a bad value. */
  async filterWhere(entityType: CustomFieldEntity, filters: readonly CustomFilter[] | undefined): Promise<JsonCondition[]> {
    if (!filters || filters.length === 0) return [];
    const byKey = new Map((await this.activeRows(entityType, this.prisma)).map((d) => [d.key, d]));
    return filters.map((f) => {
      const def = byKey.get(f.key);
      const cond = def ? filterCondition(ruleOf(def), f) : null;
      if (!cond) throw unprocessable('custom_filter_invalid', 'That custom field filter is not valid');
      return cond;
    });
  }

  // ---- CSV ----

  /** Header names and rules for the custom field columns of an export or an import: `cf:<key>`. */
  async csvColumns(entityType: CustomFieldEntity): Promise<Array<{ column: string; def: RuleDef }>> {
    return (await this.activeRows(entityType, this.prisma)).map((d) => ({ column: `cf:${d.key}`, def: ruleOf(d) }));
  }

  csvCell(def: RuleDef, values: unknown): ReturnType<typeof toCsvCell> {
    return toCsvCell(def, ownValue(values, def.key));
  }

  csvParse(def: RuleDef, cell: string) {
    return fromCsvCell(def, cell);
  }

  // ---- Customers ----

  /** The values a customer may see: active fields marked visible, with a value. Never anything else from the row. */
  async publicView(entityType: CustomFieldEntity, values: unknown): Promise<PublicCustomField[]> {
    if (!values || typeof values !== 'object' || !CUSTOM_FIELD_TARGETS[entityType].customerVisible) return [];
    const defs = (await this.activeRows(entityType, this.prisma)).filter((d) => d.visibleToCustomer && !isBlank(ownValue(values, d.key)));
    return defs.map((d) => {
      const value = ownValue(values, d.key) as CustomValue;
      const out: PublicCustomField = { key: d.key, label: d.label as Record<string, string>, type: d.type, value };
      if (d.type === 'select' || d.type === 'multiselect') {
        const chosen = new Set(Array.isArray(value) ? value : [value]);
        out.options = ((d.options as CustomFieldOption[] | null) ?? []).filter((o) => chosen.has(o.value)).map((o) => ({ value: o.value, label: o.label }));
      }
      return out;
    });
  }
}
