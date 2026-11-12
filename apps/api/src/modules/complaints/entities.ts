import type { EntityDef } from '../../platform/entities/entity-registry';
import { complaintTable } from './tables';
import type { Tx } from './support';

const ERASED = '[redacted]';

/**
 * A complaint reaches its customer by a column. The complainant's words, name and address are personal data and the
 * staff notes can hold anything, so export gives all of it and erasure redacts the text. The dates, category, status and
 * outcome stay: they are what shows the complaints procedure was followed, and they say nothing about the person.
 */
export const COMPLAINT_ENTITY: EntityDef = {
  entityType: 'Complaint', model: 'Complaint', customerLink: { kind: 'column', column: 'customerId' }, table: complaintTable,
  handlers: {
    export: async (tx: Tx, customerId) => {
      const complaints = await tx.complaint.findMany({
        where: { customerId },
        select: {
          id: true, reference: true, complainantName: true, complainantEmail: true, channel: true, category: true, summary: true, description: true, status: true,
          receivedDate: true, acknowledgeDueDate: true, resolveDueDate: true, acknowledgedAt: true, outcome: true, resolutionSummary: true, resolvedAt: true, closedAt: true, withdrawnAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });
      // Deleted notes are still stored, so they are exported too.
      const notes = complaints.length === 0 ? [] : await tx.note.findMany({ where: { entityType: 'Complaint', entityId: { in: complaints.map((c) => c.id) } }, select: { entityType: true, entityId: true, body: true, pinned: true, createdAt: true, deletedAt: true }, orderBy: { createdAt: 'asc' } });
      return [...complaints.map(({ id: _id, ...c }) => c), ...notes];
    },
    anonymise: async (tx: Tx, customerId) => {
      const ids = (await tx.complaint.findMany({ where: { customerId }, select: { id: true } })).map((c) => c.id);
      if (ids.length === 0) return;
      await tx.note.updateMany({ where: { entityType: 'Complaint', entityId: { in: ids } }, data: { body: ERASED } });
      await tx.complaint.updateMany({ where: { id: { in: ids } }, data: { complainantName: ERASED, complainantEmail: null, summary: ERASED, description: ERASED } });
      await tx.complaint.updateMany({ where: { id: { in: ids }, resolutionSummary: { not: null } }, data: { resolutionSummary: ERASED } });
    },
  },
};
