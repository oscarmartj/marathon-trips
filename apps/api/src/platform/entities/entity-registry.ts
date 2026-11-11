import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppError } from '../errors/safe-error';

/**
 * How a record reaches its customer. The audit service (0.3) uses it to fill AuditPiiValue.subjectCustomerId, and
 * the erasure and export tasks (5.5) build their lists from it, not from a hand-written table (plan 4.9).
 */
export type CustomerLink =
  | { kind: 'self' } // the model is the customer
  | { kind: 'column'; column: string } // a column on the row holds customerId
  | { kind: 'via'; entityType: string; column: string }; // a column on the row points at another registered entity

export interface EntityHandlers {
  /** Returns this customer's rows for a data export. */
  export(tx: Prisma.TransactionClient, customerId: string): Promise<unknown[]>;
  /** Anonymises or deletes this customer's rows. Must never update an immutable table. */
  anonymise(tx: Prisma.TransactionClient, customerId: string): Promise<void>;
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
