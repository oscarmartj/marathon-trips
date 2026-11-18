import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { TableDef } from '../common/table-def';
import { AppError } from '../errors/safe-error';

/**
 * How a record reaches its customer. The audit service (0.3) uses it to fill AuditPiiValue.subjectCustomerId, and
 * the erasure and export tasks (5.5) build their lists from it, not from a hand-written table (plan 4.9).
 */
export type CustomerLink =
  | { kind: 'self' } // the model is the customer
  | { kind: 'column'; column: string } // a column on the row holds customerId
  | { kind: 'via'; entityType: string; column: string }; // a column on the row points at another registered entity

/**
 * Who an export is for (task 5.5, plan docs/plans/5.5-privacy-export-erase.md, section 4). `subject` (the default) is
 * what the customer may download: no staff notes and no internal text. Staff notes are polymorphic rows that the privacy
 * module adds itself for `full`, the owner's export for a formal access request.
 */
export type ExportAudience = 'subject' | 'full';

export interface ExportOptions {
  audience?: ExportAudience;
  /** The customer's and its user's addresses, lower-cased, for rows linked only by address. */
  emails?: readonly string[];
}

/** What erasure knows before anything changes: the addresses (lower-cased) and the customer's user, if any. */
export interface ErasureContext {
  emails: readonly string[];
  userId: string | null;
}

/**
 * The contract every module with customer data follows (plan 5.5, section 4). Both run inside the privacy module's
 * transaction, with the customer and its bookings already locked FOR UPDATE; further locks follow plan 0.1, 6.3
 * (Booking -> Payment -> PaymentLink / waiting list entries / own rows, by id).
 */
export interface EntityHandlers {
  /** Returns this customer's rows for a data export, as the customer may see them. Never staff notes. */
  export(tx: Prisma.TransactionClient, customerId: string, opts?: ExportOptions): Promise<unknown[]>;
  /**
   * Anonymises every personal column of this customer's rows, or deletes rows with no value of their own. Idempotent.
   * Must never update an immutable table. Rows linked only by address match `lower(column) = ANY(ctx.emails)`.
   */
  anonymise(tx: Prisma.TransactionClient, customerId: string, ctx?: ErasureContext): Promise<void>;
}

export interface EntityDef {
  /** Name used in AuditLog.entityType, such as Booking. */
  entityType: string;
  /** Prisma model name. */
  model: string;
  /** Absent for entities with no customer (Race, Supplier). */
  customerLink?: CustomerLink;
  /** Required when customerLink is present. */
  handlers?: EntityHandlers;
  /** Panel table capabilities (task 0.5): search, filters, views, bulk actions, CSV, tags, notes, history, soft delete. */
  table?: TableDef;
}

@Injectable()
export class EntityRegistry {
  private readonly entities = new Map<string, EntityDef>();

  register(def: EntityDef): void {
    if (this.entities.has(def.entityType)) throw new AppError('entity_duplicate', `Entity ${def.entityType} is already registered`);
    if (def.customerLink && !def.handlers) throw new AppError('entity_handlers_missing', `Entity ${def.entityType} has a customer link but no export and anonymise handlers`);
    this.entities.set(def.entityType, def);
  }

  get(entityType: string): EntityDef | undefined {
    return this.entities.get(entityType);
  }

  all(): EntityDef[] {
    return [...this.entities.values()];
  }

  withCustomerLink(): EntityDef[] {
    return this.all().filter((e) => e.customerLink);
  }

  /** Call once everything is registered: every `via` link must point at a registered entity that reaches a customer. */
  validate(): void {
    for (const e of this.withCustomerLink()) {
      const seen = new Set<string>([e.entityType]);
      let link = e.customerLink!;
      while (link.kind === 'via') {
        const next = this.entities.get(link.entityType);
        if (!next?.customerLink) throw new AppError('entity_link_broken', `Entity ${e.entityType} links through ${link.entityType}, which has no customer link`);
        if (seen.has(next.entityType)) throw new AppError('entity_link_cycle', `Entity ${e.entityType} has a circular customer link`);
        seen.add(next.entityType);
        link = next.customerLink;
      }
    }
  }
}
