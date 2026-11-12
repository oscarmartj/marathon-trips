import { COMPLAINT_CATEGORIES, COMPLAINT_STATUSES } from '@mt/shared';
import type { TableDef } from '../../platform/common/table-def';
import { COMPLAINTS_PERMISSIONS as P } from './manifest';

// The shared table tools of task 0.5 (notes, tags and history) for complaints. The list is its own route because it
// filters by deadline, so only the per-record tools are used. A complaint is never deleted (softDelete off) and has no
// bulk actions, CSV or global search entry: complaint text is not copied into another table.
export const complaintTable: TableDef = {
  entityType: 'Complaint', model: 'Complaint',
  permissions: { read: P.read, write: P.manage, annotate: P.manage },
  softDelete: false, versioned: true, taggable: true, notes: true, historyShowsPii: true,
  columns: [
    { key: 'reference', type: 'text', sortable: true, filterable: true, searchable: true },
    { key: 'status', type: 'enum', values: COMPLAINT_STATUSES, sortable: true, filterable: true },
    { key: 'category', type: 'enum', values: COMPLAINT_CATEGORIES, sortable: true, filterable: true },
    { key: 'receivedDate', type: 'date', sortable: true, filterable: true },
    { key: 'resolveDueDate', type: 'date', sortable: true, filterable: true },
  ],
};
