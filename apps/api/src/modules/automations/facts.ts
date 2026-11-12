import { automationFactsSchema, triggerOf } from '@mt/shared';
import type { AutomationEntityType, AutomationFacts } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { readBookingForAutomations } from '../bookings';
import type { BookingForAutomations } from '../bookings';
import { readPackageForAutomations } from '../catalogue';
import type { PackageForAutomations } from '../catalogue';
import { readQuoteForAutomations } from '../crm';
import type { QuoteForAutomations } from '../crm';

type Tx = Prisma.TransactionClient;

/** The record a run is about, read through its module's public reader (never Prisma on its tables from here). */
export type LoadedEntity =
  | { entityType: 'Booking'; id: string; booking: BookingForAutomations }
  | { entityType: 'Quote'; id: string; quote: QuoteForAutomations }
  | { entityType: 'Package'; id: string; pkg: PackageForAutomations };

export async function loadEntity(tx: Tx, entityType: AutomationEntityType, id: string): Promise<LoadedEntity | null> {
  if (entityType === 'Booking') {
    const booking = await readBookingForAutomations(tx, id);
    return booking ? { entityType, id, booking } : null;
  }
  if (entityType === 'Quote') {
    const quote = await readQuoteForAutomations(tx, id);
    return quote ? { entityType, id, quote } : null;
  }
  const pkg = await readPackageForAutomations(tx, id);
  return pkg && !pkg.deleted ? { entityType, id, pkg } : null;
}

const ACTOR_TYPES = new Set(['staff', 'customer', 'system', 'api_key']);
const STATUS = /^[a-z][a-z_]{0,39}$/;

/**
 * The facts conditions may test, for one trigger and record. `event` is the triggering event (absent in a panel test:
 * then `actorType` and the package's `fromStatus` are unknown and stay null). The result is validated strictly: only
 * ids, codes, booleans and tag ids, so it can be stored on the run.
 */
export function factsOf(eventType: string, entity: LoadedEntity, event?: { actorType: string; payload: unknown }): AutomationFacts {
  const trigger = triggerOf(eventType);
  const actorType = event && ACTOR_TYPES.has(event.actorType) ? event.actorType : null;
  const payload = (event?.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
  let facts: AutomationFacts = {};
  if (entity.entityType === 'Booking') {
    const b = entity.booking;
    facts = { status: b.status, packageId: b.packageId, editionId: b.editionId, raceId: b.raceId, fromQuote: b.fromQuote, actorType, tagIds: b.tagIds };
  } else if (entity.entityType === 'Quote') {
    const q = entity.quote;
    facts = { status: q.status, packageId: q.packageId, editionId: q.editionId, raceId: q.raceId, actorType };
  } else {
    const p = entity.pkg;
    const from = typeof payload.fromStatus === 'string' && STATUS.test(payload.fromStatus) ? payload.fromStatus : null;
    const to = typeof payload.toStatus === 'string' && STATUS.test(payload.toStatus) ? payload.toStatus : event ? null : p.saleStatus;
    facts = { packageId: p.id, editionId: p.editionId, raceId: p.raceId, fromStatus: from, toStatus: to, actorType };
  }
  // Only the facts this trigger declares are kept.
  const declared = trigger ? Object.keys(trigger.facts) : [];
  return automationFactsSchema.parse(Object.fromEntries(Object.entries(facts).filter(([k]) => declared.includes(k))));
}
