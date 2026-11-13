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
      export: (tx: Tx, customerId) => tx.webhookEvent.findMany({ where: { booking: { customerId } }, select: { bookingId: true, type: true, receivedAt: true, status: true } }),
      anonymise: async (tx: Tx, customerId) => {
        await tx.webhookEvent.updateMany({ where: { booking: { customerId }, rawBody: { not: null } }, data: { rawBody: null } });
      },
    },
  },
];
