import type { QuoteStatus } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';

/** What automations read about a quote (task 7.4): ids and codes for conditions, and what its emails need. */
export interface QuoteForAutomations {
  id: string;
  reference: string;
  status: QuoteStatus;
  packageId: string;
  editionId: string;
  raceId: string;
  customer: { id: string; email: string; givenName: string; preferredLocale: string; unavailable: boolean };
  trip: { raceName: unknown; year: number; packageName: unknown };
}

/** A plain read, no lock. Null when the quote does not exist. */
export async function readQuoteForAutomations(tx: Prisma.TransactionClient, id: string): Promise<QuoteForAutomations | null> {
  const q = await tx.quote.findUnique({
    where: { id },
    select: {
      id: true, reference: true, status: true, packageId: true, editionId: true,
      customer: { select: { id: true, email: true, givenName: true, preferredLocale: true, anonymisedAt: true, deletedAt: true } },
      package: { select: { name: true } }, edition: { select: { year: true, raceId: true, race: { select: { name: true } } } },
    },
  });
  if (!q) return null;
  return {
    id: q.id, reference: q.reference, status: q.status as QuoteStatus, packageId: q.packageId, editionId: q.editionId, raceId: q.edition.raceId,
    customer: { id: q.customer.id, email: q.customer.email, givenName: q.customer.givenName, preferredLocale: q.customer.preferredLocale, unavailable: !!(q.customer.anonymisedAt || q.customer.deletedAt) },
    trip: { raceName: q.edition.race.name, year: q.edition.year, packageName: q.package.name },
  };
}
