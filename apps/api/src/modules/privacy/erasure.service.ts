import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ErasureBlockReason } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../../platform/access/access.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { AuditService } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import type { ErasureContext } from '../../platform/entities/entity-registry';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, forbidden, notFound } from '../../platform/http/api-error';
import { ADDRESS_LINKED_ENTITIES, NO_CUSTOMER, customerRecordIds, erasePlatformRows, erasePolymorphic } from '../../platform/privacy/records';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { ConsentService } from './consent.service';
import { PRIVACY_EVENTS } from './manifest';

type Tx = Prisma.TransactionClient;

export interface ErasureResult {
  customerId: string;
  status: 'completed';
  alreadyErased: boolean;
}

const lower = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => !!x).map((x) => x.trim().toLowerCase()))];

/** Test seam: called with the customer locked and its bookings locked, before anything is checked or changed. */
export const erasureHooks = { afterLocks: async (_customerId: string): Promise<void> => undefined };

/**
 * Erasing a customer (task 5.5, plan docs/plans/5.5-privacy-export-erase.md, section 5). One transaction: customer, then
 * its bookings, locked FOR UPDATE (plan 0.1, 6.3); the active-trip rule; every registered handler; the executor's own
 * tables; notes, tasks and search documents on the customer's records; and last privacy_erase_customer (mt_privacy), which
 * removes the audit log's personal values. Idempotent: an anonymised customer is answered as erased, with nothing written.
 */
@Injectable()
export class ErasureService {
  private readonly logger = new Logger('Privacy');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntityRegistry) private readonly registry: EntityRegistry,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ConsentService) private readonly consent: ConsentService,
  ) {}

  /** Owner only: a custom role given the permission is not enough (plan section 8). */
  async assertOwner(userId: string): Promise<void> {
    if (!(await this.access.isOwner(this.prisma, userId))) throw forbidden('owner_only', 'Only an owner can do this');
  }

  /** The shared rule (privacy_active_trip_reason, migration 0027). */
  async blockedBy(db: Tx | PrismaService, customerId: string): Promise<ErasureBlockReason | null> {
    const [row] = await db.$queryRaw<Array<{ reason: string | null }>>`SELECT public.privacy_active_trip_reason(${customerId}::uuid) AS reason`;
    return (row?.reason ?? null) as ErasureBlockReason | null;
  }

  async erase(customerId: string, actor: AuditActor): Promise<ErasureResult> {
    let rejected: ErasureBlockReason | null = null;
    const result = await runTransaction(this.prisma, async (tx): Promise<ErasureResult | null> => {
      rejected = null;
      const [c] = await tx.$queryRaw<Array<{ id: string; email: string; userId: string | null; anonymisedAt: Date | null }>>`
        SELECT id::text AS id, email::text AS email, "userId"::text AS "userId", "anonymisedAt" FROM customers WHERE id = ${customerId}::uuid FOR UPDATE`;
      if (!c) throw notFound();
      if (c.anonymisedAt) return { customerId, status: 'completed', alreadyErased: true };
      await tx.$queryRaw`SELECT id FROM bookings WHERE "customerId" = ${customerId}::uuid ORDER BY id FOR UPDATE`;
      await erasureHooks.afterLocks(customerId);

      const reason = await this.blockedBy(tx, customerId);
      if (reason) {
        rejected = reason;
        return null;
      }

      const user = c.userId ? await tx.user.findUnique({ where: { id: c.userId }, select: { email: true } }) : null;
      const ctx: ErasureContext = { emails: lower([c.email, user?.email]), userId: c.userId };

      await this.consent.withdrawForErasure(tx, customerId, ctx.emails);
      const defs = this.registry.withCustomerLink();
      for (const def of [...defs.filter((d) => d.customerLink!.kind !== 'self'), ...defs.filter((d) => d.customerLink!.kind === 'self')]) {
        await def.handlers!.anonymise(tx, customerId, ctx);
      }
      await erasePlatformRows(tx, { customerId, userId: c.userId, emails: ctx.emails });
      await erasePolymorphic(tx, await customerRecordIds(tx, this.registry, customerId));
      await tx.$queryRaw`SELECT public.privacy_erase_customer(${customerId}::uuid)`;

      const open = await tx.privacyRequest.findFirst({ where: { customerId, kind: 'erasure', status: 'received' }, select: { id: true } });
      const now = new Date();
      if (open) await tx.privacyRequest.update({ where: { id: open.id }, data: { status: 'completed', completedAt: now, actorUserId: actor.type === 'staff' ? actor.id : null } });
      else await tx.privacyRequest.create({ data: { customerId, kind: 'erasure', status: 'completed', requestedBy: 'staff', completedAt: now, actorUserId: actor.type === 'staff' ? actor.id : null } });
      await this.tasks.closeSystemIn(tx, `privacy:erasure:${customerId}`);
      await this.audit.record(tx, { actor, action: 'privacy.customer.erased', entityType: 'Customer', entityId: customerId, context: { requestedBy: open ? 'customer' : 'staff' } });
      await this.outbox.publish(tx, { type: PRIVACY_EVENTS.customerErased, aggregateType: 'Customer', aggregateId: customerId, payload: { customerId }, actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}) });
      return { customerId, status: 'completed', alreadyErased: false };
    });
    if (!result) {
      // Nothing changed (the transaction wrote nothing); the attempt is recorded on its own, without personal data, and an
      // open customer request stays open (review point 16).
      await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action: 'privacy.erasure.rejected', entityType: 'Customer', entityId: customerId, context: { reason: rejected } }));
      throw conflict('erasure_rejected_with_active_trip', 'This customer has a trip or a payment that is not finished. Close it first.');
    }
    // One line per erasure, the id only: the list to apply again after restoring an older backup (plan section 2.11).
    if (!result.alreadyErased) this.logger.log(`privacy.customer.erased ${customerId}`);
    return result;
  }

  /**
   * A customer asks for erasure from their account (plan section 2.1): one open request and a system task for staff.
   * Idempotent: asking again returns the open request.
   */
  async requestByCustomer(tx: Tx, customerId: string, actor: AuditActor): Promise<{ status: 'received'; requestedAt: Date }> {
    const open = await tx.privacyRequest.findFirst({ where: { customerId, kind: 'erasure', status: 'received' }, select: { requestedAt: true } });
    if (open) return { status: 'received', requestedAt: open.requestedAt };
    const row = await tx.privacyRequest.create({ data: { customerId, kind: 'erasure', requestedBy: 'customer' }, select: { id: true, requestedAt: true } });
    await this.tasks.createSystemIn(tx, {
      title: 'Privacy: a customer asked us to erase their data', description: 'Check for open trips or payments, then erase the customer from their page (Privacy panel).',
      entityType: 'Customer', entityId: customerId, sourceRef: `privacy:erasure:${customerId}`,
    });
    await this.audit.record(tx, { actor, action: 'privacy.erasure.requested', entityType: 'Customer', entityId: customerId, context: { requestId: row.id } });
    return { status: 'received', requestedAt: row.requestedAt };
  }

  /**
   * A sign-in account that never became a customer erases itself (plan section 2.1): nothing staff need is attached.
   * The user row is locked first; a customer created meanwhile (it would lock the same user first) sends the person to
   * the normal request instead.
   */
  async eraseAccount(userId: string, actor: AuditActor): Promise<void> {
    await runTransaction(this.prisma, async (tx) => {
      const [u] = await tx.$queryRaw<Array<{ email: string; anonymisedAt: Date | null }>>`
        SELECT email::text AS email, "anonymisedAt" FROM users WHERE id = ${userId}::uuid AND kind = 'customer' FOR UPDATE`;
      if (!u) throw notFound();
      if (u.anonymisedAt) return;
      if (await tx.customer.findFirst({ where: { OR: [{ userId }, { email: { equals: u.email, mode: 'insensitive' } }] }, select: { id: true } })) {
        throw conflict('customer_record_exists', 'Ask us to erase your data instead');
      }
      const emails = lower([u.email]);
      // Complaints logged with this address and no customer (review round 2): their ids now, before the handler
      // redacts the address, so their tasks and audit values can be erased too.
      const complaints = (await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM complaints WHERE "customerId" IS NULL AND lower("complainantEmail") = ANY(${emails}::text[])`).map((r) => r.id);
      for (const def of this.registry.withCustomerLink().filter((d) => ADDRESS_LINKED_ENTITIES.includes(d.entityType))) await def.handlers!.anonymise(tx, NO_CUSTOMER, { emails, userId });
      const hash = this.consent.hashOf(u.email);
      if (await tx.consentRecord.findFirst({ where: { emailHash: hash }, select: { id: true } })) {
        await tx.consentRecord.create({ data: { emailHash: hash, purpose: 'marketing_email', granted: false, source: 'erasure', wordingKey: 'marketing_email.v1' } });
      }
      await erasePlatformRows(tx, { customerId: null, userId, emails });
      await erasePolymorphic(tx, new Map([['Complaint', complaints]]));
      await tx.$queryRaw`SELECT public.privacy_erase_account(${userId}::uuid, ${complaints}::uuid[])`;
      await tx.privacyRequest.create({ data: { userId, kind: 'erasure', status: 'completed', requestedBy: 'customer', completedAt: new Date(), actorUserId: userId } });
      await this.audit.record(tx, { actor, action: 'privacy.account.erased', entityType: 'User', entityId: userId });
    });
    this.logger.log(`privacy.account.erased ${userId}`);
  }

  /** Completed erasures (customer and account ids only): the list to re-apply after restoring a backup (plan 2.11). */
  async erasedIds(): Promise<Array<{ customerId: string | null; userId: string | null; completedAt: Date | null }>> {
    return this.prisma.privacyRequest.findMany({ where: { kind: 'erasure', status: 'completed' }, select: { customerId: true, userId: true, completedAt: true }, orderBy: { completedAt: 'asc' } });
  }
}
