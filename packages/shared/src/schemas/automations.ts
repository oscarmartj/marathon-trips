import { z } from 'zod';
import { BOOKING_STATUSES } from './bookings';
import { SALE_STATUSES, versionSchema } from './catalogue';
import { QUOTE_STATUSES } from './crm';

// Automations (task 7.4), shared by the API and the panel. Triggers, facts, operators and actions are closed lists:
// a rule can only use what is declared here, and nothing here moves money, changes a booking's state or touches
// permissions (plan docs/plans/7.4-automations.md). Labels live in the web app's messages, keyed by these codes.

const uuid = z.string().uuid();

/** Who caused the triggering event. `automation` never starts a run (loop guard), so it is not offered. */
export const AUTOMATION_ACTOR_TYPES = ['staff', 'customer', 'system', 'api_key'] as const;

export type FactKind =
  | { kind: 'uuid'; ref: 'package' | 'edition' | 'race' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'boolean' }
  | { kind: 'tags' };

const bookingFacts = {
  status: { kind: 'enum', values: BOOKING_STATUSES },
  packageId: { kind: 'uuid', ref: 'package' },
  editionId: { kind: 'uuid', ref: 'edition' },
  raceId: { kind: 'uuid', ref: 'race' },
  fromQuote: { kind: 'boolean' },
  actorType: { kind: 'enum', values: AUTOMATION_ACTOR_TYPES },
  tagIds: { kind: 'tags' },
} as const satisfies Record<string, FactKind>;

const quoteFacts = {
  status: { kind: 'enum', values: QUOTE_STATUSES },
  packageId: { kind: 'uuid', ref: 'package' },
  editionId: { kind: 'uuid', ref: 'edition' },
  raceId: { kind: 'uuid', ref: 'race' },
  actorType: { kind: 'enum', values: AUTOMATION_ACTOR_TYPES },
} as const satisfies Record<string, FactKind>;

const packageFacts = {
  packageId: { kind: 'uuid', ref: 'package' },
  editionId: { kind: 'uuid', ref: 'edition' },
  raceId: { kind: 'uuid', ref: 'race' },
  fromStatus: { kind: 'enum', values: SALE_STATUSES },
  toStatus: { kind: 'enum', values: SALE_STATUSES },
  actorType: { kind: 'enum', values: AUTOMATION_ACTOR_TYPES },
} as const satisfies Record<string, FactKind>;

export const AUTOMATION_ENTITY_TYPES = ['Booking', 'Quote', 'Package'] as const;
export type AutomationEntityType = (typeof AUTOMATION_ENTITY_TYPES)[number];

export interface AutomationTriggerDef {
  entityType: AutomationEntityType;
  facts: Readonly<Record<string, FactKind>>;
}

/** The events that can start a rule. Payments, changes, access, auth and automation events never can. */
export const AUTOMATION_EVENT_TRIGGERS = {
  'bookings.booking.requested': { entityType: 'Booking', facts: bookingFacts },
  'bookings.booking.approved': { entityType: 'Booking', facts: bookingFacts },
  'bookings.booking.declined': { entityType: 'Booking', facts: bookingFacts },
  'bookings.booking.cancelled': { entityType: 'Booking', facts: bookingFacts },
  'bookings.booking.expired': { entityType: 'Booking', facts: bookingFacts },
  'crm.quote.sent': { entityType: 'Quote', facts: quoteFacts },
  'crm.quote.accepted': { entityType: 'Quote', facts: quoteFacts },
  'crm.quote.expired': { entityType: 'Quote', facts: quoteFacts },
  'catalogue.package.sale_status_changed': { entityType: 'Package', facts: packageFacts },
} as const satisfies Record<string, AutomationTriggerDef>;

export type AutomationEventType = keyof typeof AUTOMATION_EVENT_TRIGGERS;
export const AUTOMATION_EVENT_TYPES = Object.keys(AUTOMATION_EVENT_TRIGGERS) as AutomationEventType[];
export const triggerOf = (eventType: string): AutomationTriggerDef | undefined =>
  (AUTOMATION_EVENT_TRIGGERS as Record<string, AutomationTriggerDef>)[eventType];

export const AUTOMATION_OPERATORS = ['is', 'is_not', 'in', 'not_in', 'has_tag', 'lacks_tag'] as const;
export type AutomationOperator = (typeof AUTOMATION_OPERATORS)[number];

/** Which operators each kind of fact accepts. */
export const OPERATORS_BY_KIND: Readonly<Record<FactKind['kind'], readonly AutomationOperator[]>> = {
  uuid: ['is', 'is_not', 'in', 'not_in'],
  enum: ['is', 'is_not', 'in', 'not_in'],
  boolean: ['is'],
  tags: ['has_tag', 'lacks_tag'],
};

export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 10;
export const MAX_ENABLED_RULES = 50;
export const MAX_REAL_RUNS_PER_HOUR = 100;

const factKey = z.string().regex(/^[a-z][a-zA-Z]{0,39}$/);
const enumValue = z.string().regex(/^[a-z][a-z_]{0,39}$/);
const scalar = z.union([uuid, enumValue, z.boolean()]);

/** One condition. The value's kind is checked against the trigger's fact on the server (and in the panel). */
export const automationConditionSchema = z.strictObject({
  fact: factKey,
  op: z.enum(AUTOMATION_OPERATORS),
  value: z.union([scalar, z.array(z.union([uuid, enumValue])).min(1).max(20)]),
});
export type AutomationCondition = z.infer<typeof automationConditionSchema>;

export const AUTOMATION_SCHEDULE_FREQUENCIES = ['daily', 'weekly'] as const;

/** A time of day in five-minute steps, in the business time zone. */
export const automationScheduleSchema = z
  .strictObject({
    frequency: z.enum(AUTOMATION_SCHEDULE_FREQUENCIES),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5][05]$/),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  })
  .superRefine((s, ctx) => {
    const days = s.weekdays ?? [];
    if (new Set(days).size !== days.length) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Each weekday once' });
    if (s.frequency === 'weekly' && days.length === 0) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Choose at least one weekday' });
    if (s.frequency === 'daily' && days.length > 0) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'A daily schedule has no weekdays' });
  });
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

/** Email templates an automation may send (their wording is edited in the templates panel, task 5.4). */
export const AUTOMATION_EMAIL_TEMPLATES = ['customer_notice_1', 'customer_notice_2', 'customer_notice_3', 'staff_notice'] as const;
export type AutomationEmailTemplate = (typeof AUTOMATION_EMAIL_TEMPLATES)[number];
export const isCustomerTemplate = (t: AutomationEmailTemplate): boolean => t !== 'staff_notice';
export const automationTemplateKey = (t: AutomationEmailTemplate): string => `automations.${t}`;

export const AUTOMATION_ACTION_TYPES = ['create_task', 'add_tag', 'remove_tag', 'close_tasks', 'send_email', 'call_webhook'] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const automationActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('create_task'),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    dueInHours: z.number().int().min(0).max(8760).optional(),
    assigneeId: uuid.optional(),
  }),
  z.strictObject({ type: z.literal('add_tag'), tagId: uuid }),
  z.strictObject({ type: z.literal('remove_tag'), tagId: uuid }),
  z.strictObject({ type: z.literal('close_tasks'), onlyThisRule: z.boolean().default(false) }),
  z.strictObject({ type: z.literal('send_email'), template: z.enum(AUTOMATION_EMAIL_TEMPLATES) }),
  z.strictObject({ type: z.literal('call_webhook'), subscriptionId: uuid }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

const ruleFields = {
  name: z.string().trim().min(1).max(120),
  triggerType: z.enum(['event', 'schedule']),
  eventType: z.enum(AUTOMATION_EVENT_TYPES as [AutomationEventType, ...AutomationEventType[]]).optional(),
  schedule: automationScheduleSchema.optional(),
  conditions: z.array(automationConditionSchema).max(MAX_CONDITIONS).default([]),
  actions: z.array(automationActionSchema).min(1).max(MAX_ACTIONS),
};

const shapeCheck = (r: { triggerType: 'event' | 'schedule'; eventType?: string; schedule?: unknown; conditions: unknown[] }, ctx: z.RefinementCtx) => {
  if (r.triggerType === 'event' && (!r.eventType || r.schedule)) ctx.addIssue({ code: 'custom', path: ['eventType'], message: 'An event rule names its event and has no schedule' });
  if (r.triggerType === 'schedule' && (r.eventType || !r.schedule)) ctx.addIssue({ code: 'custom', path: ['schedule'], message: 'A scheduled rule has a schedule and no event' });
  if (r.triggerType === 'schedule' && r.conditions.length > 0) ctx.addIssue({ code: 'custom', path: ['conditions'], message: 'A scheduled rule has no conditions' });
};

/** A whole rule definition, as stored and as sent by the panel (create replaces nothing; update replaces all of it). */
export const automationRuleDefinitionSchema = z.strictObject(ruleFields).superRefine(shapeCheck);
export type AutomationRuleDefinition = z.infer<typeof automationRuleDefinitionSchema>;

export const createAutomationSchema = automationRuleDefinitionSchema;
export const updateAutomationSchema = z.strictObject({ ...ruleFields, version: versionSchema }).superRefine(shapeCheck);
export const enableAutomationSchema = z.strictObject({ version: versionSchema, testMode: z.boolean() });
export const disableAutomationSchema = z.strictObject({ version: versionSchema });
export const deleteAutomationQuerySchema = z.strictObject({ version: z.coerce.number().int().min(0) });
export const testAutomationSchema = z.strictObject({ entityId: uuid.optional() });
export const listAutomationRunsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

export const AUTOMATION_RUN_STATUSES = ['pending', 'succeeded', 'skipped', 'failed'] as const;
export const AUTOMATION_RUN_SOURCES = ['event', 'schedule', 'manual'] as const;

/** Why a run was skipped or failed. The database checks the same list. */
export const AUTOMATION_REASON_CODES = [
  'conditions_not_met', 'event_too_old', 'module_disabled', 'rule_disabled', 'rule_changed', 'rule_invalid', 'owner_inactive',
  'automation_cannot_exceed_author_permissions', 'entity_gone', 'rate_limited', 'stale', 'action_failed', 'transient_error',
] as const;
export type AutomationReasonCode = (typeof AUTOMATION_REASON_CODES)[number];

export const AUTOMATION_STEP_STATUSES = ['done', 'simulated', 'skipped', 'failed', 'rolled_back'] as const;
export type AutomationStepStatus = (typeof AUTOMATION_STEP_STATUSES)[number];

/** Why a step was skipped or failed. Codes only, never text from a person or a receiver. */
export const AUTOMATION_STEP_CODES = [
  'assignee_unavailable', 'recipient_unavailable', 'recipient_suppressed', 'webhook_unavailable', 'tag_unavailable', 'entity_gone',
  'already_tagged', 'not_tagged', 'nothing_to_close', 'action_failed', 'transient_error',
] as const;
export type AutomationStepCode = (typeof AUTOMATION_STEP_CODES)[number];

/** One stored step of a run: codes and ids only. */
export const automationStepSchema = z.strictObject({
  index: z.number().int().min(0).max(MAX_ACTIONS - 1),
  action: z.enum(AUTOMATION_ACTION_TYPES),
  status: z.enum(AUTOMATION_STEP_STATUSES),
  code: z.enum(AUTOMATION_STEP_CODES).optional(),
  entityType: z.string().regex(/^[A-Z][A-Za-z]{0,63}$/).optional(),
  entityId: uuid.optional(),
});
export type AutomationStep = z.infer<typeof automationStepSchema>;

/** Facts snapshotted for a run: ids, enum codes, booleans and lists of tag ids. */
export const automationFactsSchema = z.record(factKey, z.union([uuid, enumValue, z.boolean(), z.null(), z.array(uuid).max(200)]));
export type AutomationFacts = z.infer<typeof automationFactsSchema>;
