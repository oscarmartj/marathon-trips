import type { EntityDef } from '../../platform/entities/entity-registry';

/**
 * A quote reaches its customer by a column. It holds ids, dates and amounts only (the configuration is checked before it is
 * stored), so erasure leaves it as it is, and export gives the reference, state, total and dates.
 */
export const QUOTE_ENTITY: EntityDef = {
  entityType: 'Quote', model: 'Quote', customerLink: { kind: 'column', column: 'customerId' },
  handlers: {
    export: (tx, customerId) =>
      tx.quote.findMany({ where: { customerId }, select: { reference: true, status: true, currency: true, totalMinor: true, departureDate: true, returnDate: true, sentAt: true, expiresAt: true, acceptedAt: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
    anonymise: async () => undefined,
  },
};
