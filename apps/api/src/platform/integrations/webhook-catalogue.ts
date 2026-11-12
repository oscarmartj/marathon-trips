import { z } from 'zod';
import { AppError } from '../errors/safe-error';

/**
 * The outgoing webhook catalogue (task 8.4, plan 4.2 and 11). Only these exact event types can be subscribed to, and
 * each one declares the exact `data` that leaves the system: the fields are picked from the internal event payload and
 * the result is validated strictly. A new field in an internal event therefore never goes out until it is added here,
 * and a missing field fails the consumer (visible and retryable) instead of sending something half-built.
 *
 * Deliberately absent: auth.* (user and session ids), access.*, common.*, catalogue.inventory.released and
 * alerts.subscription.confirmed. They are internal or about people. Later tasks add their own types with a contract.
 */
export interface CatalogueEntry {
  type: string;
  description: string;
  /** The subscriber's creator must hold this permission: a webhook never reveals what its creator could not read. */
  readPermission: string;
  /** Payload fields that go out, by name. */
  data: z.ZodObject;
}

const uuid = z.string().uuid();

export const PING_EVENT_TYPE = 'integrations.ping';
export const AUTOMATION_RULE_FIRED = 'automations.rule.fired';

export const WEBHOOK_EVENT_CATALOGUE: readonly CatalogueEntry[] = [
  {
    type: 'catalogue.race.published',
    description: 'A race was published on the website',
    readPermission: 'catalogue.race.read',
    data: z.object({}).strict(),
  },
  {
    type: 'catalogue.package.sale_status_changed',
    description: 'A package changed sale status (for example coming soon to open)',
    readPermission: 'catalogue.package.read',
    data: z.object({ packageId: uuid, editionId: uuid, raceId: uuid, fromStatus: z.string().regex(/^[a-z_]{1,40}$/), toStatus: z.string().regex(/^[a-z_]{1,40}$/) }).strict(),
  },
  {
    type: 'pricing.price_version.published',
    description: 'A new price version of a package came into force',
    readPermission: 'pricing.priceVersion.read',
    data: z.object({ priceVersionId: uuid, packageId: uuid, previousVersionId: uuid.nullable() }).strict(),
  },
  {
    type: 'suppliers.allotment.released',
    description: 'A contracted allotment was released back to the supplier',
    readPermission: 'suppliers.supplier.read',
    data: z.object({ allotmentId: uuid, poolId: uuid.nullable(), contractId: uuid }).strict(),
  },
  {
    // Task 7.4: never published to the outbox, so never fanned out. An automation's "call a webhook" action sends it to
    // one subscription that chose this type, and only while the subscription's creator can read the rule's record.
    type: AUTOMATION_RULE_FIRED,
    description: 'An automation rule ran its "call a webhook" action',
    readPermission: 'automations.rule.read',
    data: z.object({
      ruleId: uuid, runId: uuid, triggerEventType: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/).nullable(),
      entityType: z.string().regex(/^[A-Z][A-Za-z]{0,63}$/).nullable(), entityId: uuid.nullable(), scheduledFor: z.string().datetime().nullable(),
    }).strict(),
  },
];

const BY_TYPE = new Map(WEBHOOK_EVENT_CATALOGUE.map((e) => [e.type, e]));

export const catalogueEntry = (type: string): CatalogueEntry | undefined => BY_TYPE.get(type);

export interface OutboundEventInput {
  id: string;
  type: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number | null;
  payload: unknown;
  occurredAt: Date;
}

export interface OutboundBody {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * The body for one event: picks the contract's fields from the payload and validates the result strictly. Throws
 * `webhook_payload_contract_mismatch` (fields named, never values) when a declared field is missing or malformed.
 * The actor is never included.
 */
export function buildOutboundBody(event: OutboundEventInput): OutboundBody {
  const entry = catalogueEntry(event.type);
  if (!entry) throw new AppError('webhook_event_not_in_catalogue', 'This event type is not in the outgoing catalogue');
  const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
  const picked = Object.fromEntries(Object.keys(entry.data.shape).filter((k) => k in payload).map((k) => [k, payload[k]]));
  const parsed = entry.data.safeParse(picked);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new AppError('webhook_payload_contract_mismatch', `The ${event.type} payload does not match its outgoing contract (${fields})`);
  }
  return {
    type: event.type,
    timestamp: event.occurredAt.toISOString(),
    data: {
      eventId: event.id, schemaVersion: event.schemaVersion, aggregateType: event.aggregateType, aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion, ...(parsed.data as Record<string, unknown>),
    },
  };
}

export function pingBody(subscriptionId: string, now: Date): OutboundBody {
  return { type: PING_EVENT_TYPE, timestamp: now.toISOString(), data: { subscriptionId } };
}
