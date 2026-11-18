import type { EntityDef } from '../../platform/entities/entity-registry';
import { complaintTable } from './tables';
import type { Tx } from './support';

const ERASED = '[redacted]';

/** The customer's complaints: linked to them, or logged without a link but with one of their addresses (case-insensitive). */
async function complaintIdsOf(tx: Tx, customerId: string, emails: readonly string[] = []): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM complaints
     WHERE "customerId" = ${customerId}::uuid
        OR ("customerId" IS NULL AND lower("complainantEmail") = ANY(${[...emails]}::text[]))
     ORDER BY id`;
  return rows.map((r) => r.id);
}

/**
 * A complaint reaches its customer by a column. The complainant's words, name and address are personal data, so export
 * gives them and erasure redacts the text. Staff notes on a complaint are not part of the customer's export (task 5.5:
 * the privacy module adds them to the owner's `full` export). The dates, category, status and outcome stay: they show
 * the complaints procedure was followed, and they say nothing about the person.
 *
 * A complaint logged without a customer but with one of the customer's addresses is the same person's (plan 5.5,
 * section 2.10): it is exported with theirs, and erasure first links it to the customer (so its audit values go with the
 * customer's) and then redacts it.
 */
export const COMPLAINT_ENTITY: EntityDef = {
  entityType: 'Complaint', model: 'Complaint', customerLink: { kind: 'column', column: 'customerId' }, table: complaintTable,
  handlers: {
    export: async (tx: Tx, customerId, opts) => {
      const ids = await complaintIdsOf(tx, customerId, opts?.emails);
      if (ids.length === 0) return [];
      return tx.complaint.findMany({
        where: { id: { in: ids } },
        select: {
          reference: true, complainantName: true, complainantEmail: true, channel: true, category: true, summary: true, description: true, status: true,
          receivedDate: true, acknowledgeDueDate: true, resolveDueDate: true, acknowledgedAt: true, outcome: true, resolutionSummary: true, resolvedAt: true, closedAt: true, withdrawnAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    },
    anonymise: async (tx: Tx, customerId, ctx) => {
      // A sign-in account with no customer record (task 5.5, review m6) has no customer to link to: its complaints by
      // address are redacted as they are.
      const isCustomer = (await tx.customer.count({ where: { id: customerId } })) > 0;
      if (isCustomer && ctx && ctx.emails.length > 0) {
        await tx.$executeRaw`
          UPDATE complaints SET "customerId" = ${customerId}::uuid, "updatedAt" = clock_timestamp()
           WHERE "customerId" IS NULL AND lower("complainantEmail") = ANY(${[...ctx.emails]}::text[])`;
      }
      const ids = await complaintIdsOf(tx, customerId, isCustomer ? [] : ctx?.emails);
      if (ids.length === 0) return;
      await tx.note.updateMany({ where: { entityType: 'Complaint', entityId: { in: ids } }, data: { body: ERASED } });
      await tx.complaint.updateMany({ where: { id: { in: ids } }, data: { complainantName: ERASED, complainantEmail: null, summary: ERASED, description: ERASED } });
      await tx.complaint.updateMany({ where: { id: { in: ids }, resolutionSummary: { not: null } }, data: { resolutionSummary: ERASED } });
    },
  },
};
