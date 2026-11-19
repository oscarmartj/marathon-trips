import type { Prisma } from '../../generated/prisma/client';
import type { EntityDef } from '../../platform/entities/entity-registry';

type Tx = Prisma.TransactionClient;

/**
 * How each payments table reaches its customer (plan 0.1, 4.9; task 5.5 runs the handlers). Plans and attempts hold no
 * personal data; a matched webhook's raw body can, so erasure empties it (erasure_clears_matched_webhook_raw_body).
 * Provider accounts and rejections have no customer.
 */
export const PAYMENT_ENTITIES: EntityDef[] = [
  { entityType: 'ProviderAccount', model: 'ProviderAccount' },
  { entityType: 'WebhookRejection', model: 'WebhookRejection' },
  {
    entityType: 'Payment', model: 'Payment', customerLink: { kind: 'column', column: 'payerCustomerId' },
    handlers: {
      export: (tx: Tx, customerId) => tx.payment.findMany({ where: { payerCustomerId: customerId }, select: { bookingId: true, method: true, amountMinor: true, currency: true, status: true, createdAt: true, succeededAt: true } }),
      anonymise: async () => undefined,
    },
  },
  ...(['PaymentSchedule', 'PaymentScheduleItem'] as const).map((model): EntityDef => ({
    entityType: model, model, customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' },
    handlers: {
      export: (tx: Tx, customerId) => (model === 'PaymentSchedule'
        ? tx.paymentSchedule.findMany({ where: { booking: { customerId } }, select: { id: true, bookingId: true, version: true } })
        : tx.paymentScheduleItem.findMany({ where: { schedule: { booking: { customerId } } }, select: { bookingId: true, kind: true, sequence: true, amountMinor: true, currency: true, dueDate: true, state: true } })),
      anonymise: async () => undefined,
    },
  })),
  {
    entityType: 'TermsAcceptance', model: 'TermsAcceptance', customerLink: { kind: 'column', column: 'customerId' },
    handlers: {
      export: (tx: Tx, customerId) => tx.termsAcceptance.findMany({ where: { customerId }, select: { bookingId: true, documentSlug: true, locale: true, contentVersion: true, textDigest: true, acceptedAt: true } }),
      anonymise: async () => undefined,
    },
  },
  {
    entityType: 'WebhookEvent', model: 'WebhookEvent', customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' },
    handlers: {
      // Provider events are internal records (task 5.5): only the owner's `full` export lists them.
      export: async (tx: Tx, customerId, opts) => (opts?.audience === 'full' ? tx.webhookEvent.findMany({ where: { booking: { customerId } }, select: { bookingId: true, type: true, receivedAt: true, status: true } }) : []),
      anonymise: async (tx: Tx, customerId) => {
        await tx.webhookEvent.updateMany({ where: { booking: { customerId }, rawBody: { not: null } }, data: { rawBody: null } });
      },
    },
  },
  {
    // Task 3.3: a refund's reason is staff's free text about the customer (task 4.5): erasure empties it.
    entityType: 'Refund', model: 'Refund', customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' },
    handlers: {
      export: (tx: Tx, customerId) => tx.refund.findMany({ where: { payment: { booking: { customerId } } }, select: { bookingId: true, amountMinor: true, currency: true, status: true, origin: true, createdAt: true, succeededAt: true } }),
      anonymise: async (tx: Tx, customerId) => {
        await tx.refund.updateMany({ where: { payment: { booking: { customerId } }, reason: { not: null } }, data: { reason: null } });
      },
    },
  },
  {
    // Task 3.3: the ledger holds no personal data (codes, amounts, ids) and is kept when a customer is erased.
    entityType: 'LedgerTransaction', model: 'LedgerTransaction', customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' },
    handlers: { export: async () => [], anonymise: async () => undefined },
  },
  {
    entityType: 'LedgerEntry', model: 'LedgerEntry', customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' },
    handlers: { export: async () => [], anonymise: async () => undefined },
  },
  { entityType: 'LedgerAccount', model: 'LedgerAccount' },
  {
    // Task 5.1: a link holds no personal data, but it is a way into the customer's booking: erasure revokes it and drops
    // its token hash, so nothing can use it again.
    entityType: 'PaymentLink', model: 'PaymentLink', customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' },
    handlers: {
      export: (tx: Tx, customerId) => tx.paymentLink.findMany({ where: { booking: { customerId } }, select: { bookingId: true, status: true, expiresAt: true, createdAt: true, usedAt: true, revokedAt: true } }),
      anonymise: async (tx: Tx, customerId) => {
        // Lock order Booking → Payment → PaymentLink (review round 1, point 3): the customer's bookings first, so a payment
        // succeeding through one of these links cannot interleave with the revocation.
        await tx.$queryRaw`SELECT id FROM bookings WHERE "customerId" = ${customerId}::uuid ORDER BY id FOR UPDATE`;
        await tx.paymentLink.updateMany({ where: { booking: { customerId }, status: 'active' }, data: { status: 'revoked', revokedAt: new Date(), tokenHash: null } });
        await tx.paymentLink.updateMany({ where: { booking: { customerId }, status: { in: ['revoked', 'used'] }, tokenHash: { not: null } }, data: { tokenHash: null } });
      },
    },
  },
];
