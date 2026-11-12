import type { TableDef } from '../../platform/common/table-def';
import { BOOKINGS_PERMISSIONS as P } from './manifest';

// The shared table tools of task 0.5 (search box, filters, notes, tags, history) for customers and bookings (task 2.5,
// plan section 2, point 9). Neither table has bulk actions, CSV or a deleted view, and neither goes into the global search
// index: names and addresses are not copied into another table. A booking has no list here (the inbox is its own route
// because it shows the customer); it uses the tools for its notes, tags and history.

export const customerTable: TableDef = {
  entityType: 'Customer', model: 'Customer',
  permissions: { read: P.customerRead, write: P.customerWrite, annotate: P.customerAnnotate },
  softDelete: true, versioned: true, taggable: true, notes: true, historyShowsPii: true,
  columns: [
    { key: 'givenName', type: 'text', sortable: true, filterable: true, searchable: true },
    { key: 'familyName', type: 'text', sortable: true, filterable: true, searchable: true },
    { key: 'email', type: 'text', sortable: true, filterable: true, searchable: true },
    { key: 'countryOfResidence', type: 'text', sortable: true, filterable: true },
    { key: 'source', type: 'enum', values: ['web', 'panel'], sortable: true, filterable: true },
    { key: 'createdAt', type: 'date', sortable: true, filterable: true },
  ],
};

export const bookingTable: TableDef = {
  entityType: 'Booking', model: 'Booking',
  // Nothing is written through the generic routes, so `write` only names the permission that already guards changes.
  permissions: { read: P.read, write: P.approve, annotate: P.annotate },
  softDelete: false, versioned: true, taggable: true, notes: true,
  columns: [
    { key: 'reference', type: 'text', sortable: true, filterable: true, searchable: true },
    { key: 'status', type: 'enum', values: ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed', 'declined', 'expired', 'cancelled', 'refunded'], sortable: true, filterable: true },
    { key: 'requestedAt', type: 'date', sortable: true, filterable: true },
    { key: 'requestExpiresAt', type: 'date', sortable: true, filterable: true },
  ],
};
