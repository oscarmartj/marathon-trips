import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { EntityRegistry } from '../entities/entity-registry';
import { AppError } from '../errors/safe-error';
import { FIELD_CLASSES, FieldClass } from './field-classes.generated';

export type AuditActorType = 'staff' | 'customer' | 'system' | 'automation' | 'api_key' | 'payment_link';

/** Who did it. Built by the access guard for HTTP requests; `system` for jobs and the CLI. */
export interface AuditActor {
  type: AuditActorType;
  id: string | null;
  sessionId?: string | null;
  requestId?: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { type: 'system', id: null };

/** Used as entityId when there is no entity (a failed sign-in for an unknown address): never a value. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Code-like context only (reason codes, purposes, kinds). Never free text, never an address. */
export type AuditContext = Record<string, string | number | boolean | null>;

export interface AuditRecordInput {
  actor: AuditActor;
  /** <module>.<entity>.<pastTense>, such as platform.flag.updated. */
  action: string;
  entityType: string;
  entityId: string;
  /** Prisma model whose annotations classify the fields; defaults to entityType. */
  model?: string;
  /** Row before the change (null or absent on creation). */
  before?: Record<string, unknown> | null;
  /** Row after the change (null or absent on deletion). */
  after?: Record<string, unknown> | null;
  /** Classes for fields that are not columns of `model` (such as roleKeys); a column's annotation always wins. */
  fieldClasses?: Record<string, FieldClass>;
  /** The staff member's reason, always treated as personal data (plan 4.4). */
  reason?: string | null;
  context?: AuditContext;
}

export interface AuditSubject {
  customerId?: string | null;
  userId?: string | null;
}

export type SubjectResolver = (tx: Prisma.TransactionClient, entityId: string, row: Record<string, unknown>) => Promise<AuditSubject>;

const CONTEXT_KEY = /^[a-z][A-Za-z0-9]{0,39}$/;
const CODE_VALUE = /^[a-z0-9_.:-]{0,80}$/i;

/** JSON-safe copy: bigint as a string of digits, dates as ISO strings. */
function plain(v: unknown): Prisma.InputJsonValue | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => plain(x)) as Prisma.InputJsonValue;
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)])) as Prisma.InputJsonValue;
  return v as Prisma.InputJsonValue;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

/**
 * Writes AuditLog in the caller's transaction (the signature requires one), so a change and its audit commit or roll
 * back together (plan 4.4). `changes` holds before/after only for @nopii fields; @pii fields, unannotated fields and the
 * reason go to AuditPiiValue with the "[pii]" marker; @secret fields are only "[changed]", stored nowhere.
 */
@Injectable()
export class AuditService {
  private readonly resolvers = new Map<string, SubjectResolver>();

  constructor(@Inject(EntityRegistry) private readonly entities: EntityRegistry) {}

  /** Modules register how an entity type reaches its personal-data subject (customer or customer user). */
  registerSubjectResolver(entityType: string, resolver: SubjectResolver): void {
    if (this.resolvers.has(entityType)) throw new AppError('audit_resolver_duplicate', `A subject resolver for ${entityType} is already registered`);
    this.resolvers.set(entityType, resolver);
  }

  /** Field class from the generated annotations; anything unknown is personal data (fail closed). */
  classify(model: string, field: string): FieldClass {
    return FIELD_CLASSES[model]?.[field] ?? 'pii';
  }

  async record(tx: Prisma.TransactionClient, input: AuditRecordInput): Promise<string> {
    const model = input.model ?? input.entityType;
    const before = input.before ?? null;
    const after = input.after ?? null;
    const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
    const changes: Record<string, Prisma.InputJsonValue> = {};
    const pii: Array<{ field: string; before: Prisma.InputJsonValue | null; after: Prisma.InputJsonValue | null }> = [];

    for (const f of fields) {
      const b = before?.[f];
      const a = after?.[f];
      if (before && after && same(b, a)) continue;
      const cls = FIELD_CLASSES[model]?.[f] ?? input.fieldClasses?.[f] ?? 'pii';
      if (cls === 'secret') changes[f] = '[changed]';
      else if (cls === 'nopii') changes[f] = { before: plain(b), after: plain(a) } as Prisma.InputJsonValue;
      else {
        changes[f] = '[pii]';
        pii.push({ field: f, before: plain(b), after: plain(a) });
      }
    }
    if (input.reason) {
      changes._reason = '[pii]';
      pii.push({ field: '_reason', before: null, after: input.reason });
    }
    if (input.context) {
      for (const [k, v] of Object.entries(input.context)) {
        if (!CONTEXT_KEY.test(k) || (typeof v === 'string' && !CODE_VALUE.test(v))) {
          throw new AppError('audit_context_not_a_code', 'Audit context holds codes only');
        }
      }
      changes._context = input.context as Prisma.InputJsonValue;
    }

    const log = await tx.auditLog.create({
      data: {
        actorType: input.actor.type, actorId: input.actor.id, action: input.action, entityType: input.entityType, entityId: input.entityId,
        changes, requestId: input.actor.requestId ?? null, sessionId: input.actor.sessionId ?? null,
      },
      select: { id: true },
    });
    if (pii.length > 0) {
      const subject = await this.subjectOf(tx, input.entityType, input.entityId, (after ?? before ?? {}) as Record<string, unknown>);
      await tx.auditPiiValue.createMany({
        data: pii.map((p) => ({
          auditLogId: log.id, field: p.field,
          before: p.before === null ? undefined : p.before, after: p.after === null ? undefined : p.after,
          subjectCustomerId: subject.customerId ?? null, subjectUserId: subject.userId ?? null,
        })),
      });
    }
    return log.id;
  }

  /** The data subject of a record, from a registered resolver or the entity's customerLink. */
  async subjectOf(tx: Prisma.TransactionClient, entityType: string, entityId: string, row: Record<string, unknown>): Promise<AuditSubject> {
    const resolver = this.resolvers.get(entityType);
    if (resolver) return resolver(tx, entityId, row);
    const def = this.entities.get(entityType);
    if (!def?.customerLink) return {};
    return { customerId: await this.customerOf(tx, entityType, entityId, row, new Set()) };
  }

  /** Follows the entity registry's customerLink (plan 4.9) to the customer id. */
  private async customerOf(tx: Prisma.TransactionClient, entityType: string, entityId: string, row: Record<string, unknown> | null, seen: Set<string>): Promise<string | null> {
    if (seen.has(entityType)) return null;
    seen.add(entityType);
    const def = this.entities.get(entityType);
    const link = def?.customerLink;
    if (!def || !link) return null;
    if (link.kind === 'self') return entityId;
    const data = row && link.column in row ? row : await this.load(tx, def.model, entityId);
    const value = data?.[link.column];
    if (typeof value !== 'string') return null;
    if (link.kind === 'column') return value;
    return this.customerOf(tx, link.entityType, value, null, seen);
  }

  private async load(tx: Prisma.TransactionClient, model: string, id: string): Promise<Record<string, unknown> | null> {
    const delegate = (tx as unknown as Record<string, { findUnique?: (a: unknown) => Promise<Record<string, unknown> | null> }>)[model.charAt(0).toLowerCase() + model.slice(1)];
    if (!delegate?.findUnique) return null;
    return delegate.findUnique({ where: { id } });
  }
}
