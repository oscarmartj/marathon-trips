import type { Prisma } from '../../generated/prisma/client';
import type { EntityDef } from '../../platform/entities/entity-registry';

type Tx = Prisma.TransactionClient;

const ERASED = '[redacted]';

/**
 * How traveller details reach their customer, and what export and erasure do (plan 0.1, 4.9; task 5.5 runs the
 * handlers). The details are the only personal data of task 5.2 and they live in one table. Erasure keeps the row (so a
 * trip still counts its places) but overwrites every personal column and sets `anonymisedAt`; the table's own CHECK
 * refuses a row marked erased that still holds any. No immutable table is touched. The audit values of past saves are
 * already keyed to the customer (`subjectCustomerId`), so the audit erasure covers them.
 */
export const TRAVELLER_ENTITIES: EntityDef[] = [
  {
    entityType: 'Traveller', model: 'Traveller', customerLink: { kind: 'column', column: 'customerId' },
    handlers: {
      export: (tx: Tx, customerId) => tx.traveller.findMany({
        where: { customerId }, orderBy: [{ bookingId: 'asc' }, { slot: 'asc' }],
        select: { bookingId: true, slot: true, givenName: true, familyName: true, dateOfBirth: true, emergencyContactName: true, emergencyContactPhone: true, estimatedFinishSeconds: true, createdAt: true, updatedAt: true },
      }),
      anonymise: async (tx: Tx, customerId) => {
        await tx.traveller.updateMany({
          where: { customerId },
          data: { givenName: ERASED, familyName: ERASED, dateOfBirth: null, emergencyContactName: null, emergencyContactPhone: null, estimatedFinishSeconds: null, anonymisedAt: new Date() },
        });
      },
    },
  },
];
