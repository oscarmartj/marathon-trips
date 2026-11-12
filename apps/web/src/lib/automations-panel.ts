import { AUTOMATION_EVENT_TRIGGERS, OPERATORS_BY_KIND } from '@mt/shared';
import type { AutomationAction, AutomationOperator, AutomationSchedule, FactKind } from '@mt/shared';

/**
 * The automation editor's rules as plain functions, so they can be tested without a browser (task 7.4). The API checks
 * everything again: which facts, operators, actions and permissions a rule may use. This only shapes the form.
 */

export interface RuleView {
  id: string;
  name: string;
  triggerType: 'event' | 'schedule';
  eventType?: string;
  schedule?: AutomationSchedule;
  conditions: Array<{ fact: string; op: AutomationOperator; value: string | boolean | string[] }>;
  actions: AutomationAction[];
  enabled: boolean;
  testMode: boolean;
  version: number;
  permissions: string[];
  lastRun?: { status: string; startedAt: string; testMode: boolean } | null;
}

export interface RunView {
  id: string;
  source: 'event' | 'schedule' | 'manual';
  triggerEventType: string | null;
  scheduledFor: string | null;
  entityType: string | null;
  entityId: string | null;
  testMode: boolean;
  status: 'pending' | 'succeeded' | 'skipped' | 'failed';
  reasonCode: string | null;
  steps: StepView[];
  startedAt: string;
}

export interface StepView {
  index: number;
  action: string;
  status: string;
  code?: string;
}

export interface ConditionRow {
  fact: string;
  op: AutomationOperator;
  /** One value, or several separated by commas for "in" and "not in". */
  value: string;
}

export type ActionRow =
  | { type: 'create_task'; title: string; description: string; dueInHours: string; assigneeId: string }
  | { type: 'add_tag' | 'remove_tag'; tagId: string }
  | { type: 'close_tasks'; onlyThisRule: boolean }
  | { type: 'send_email'; template: string }
  | { type: 'call_webhook'; subscriptionId: string };

export interface RuleForm {
  name: string;
  triggerType: 'event' | 'schedule';
  eventType: string;
  frequency: 'daily' | 'weekly';
  time: string;
  weekdays: number[];
  conditions: ConditionRow[];
  actions: ActionRow[];
}

export const EVENT_TYPES = Object.keys(AUTOMATION_EVENT_TRIGGERS);
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function factsFor(eventType: string): Array<[string, FactKind]> {
  const t = (AUTOMATION_EVENT_TRIGGERS as Record<string, { facts: Record<string, FactKind> }>)[eventType];
  return t ? Object.entries(t.facts) : [];
}

export function operatorsFor(eventType: string, fact: string): readonly AutomationOperator[] {
  const kind = factsFor(eventType).find(([k]) => k === fact)?.[1];
  return kind ? OPERATORS_BY_KIND[kind.kind] : [];
}

/** The values a fact can take when it is a closed list (enum or yes/no); null when it is an id typed by staff. */
export function valuesFor(eventType: string, fact: string): readonly string[] | null {
  const kind = factsFor(eventType).find(([k]) => k === fact)?.[1];
  if (!kind) return null;
  if (kind.kind === 'enum') return kind.values;
  if (kind.kind === 'boolean') return ['true', 'false'];
  return null;
}

export const blankAction = (type: ActionRow['type']): ActionRow => {
  switch (type) {
    case 'create_task': return { type, title: '', description: '', dueInHours: '', assigneeId: '' };
    case 'add_tag':
    case 'remove_tag': return { type, tagId: '' };
    case 'close_tasks': return { type, onlyThisRule: false };
    case 'send_email': return { type, template: 'staff_notice' };
    default: return { type: 'call_webhook', subscriptionId: '' };
  }
};

export function emptyForm(): RuleForm {
  return { name: '', triggerType: 'event', eventType: EVENT_TYPES[0]!, frequency: 'daily', time: '08:00', weekdays: [], conditions: [], actions: [blankAction('create_task')] };
}

export function formFromRule(r: RuleView): RuleForm {
  return {
    name: r.name, triggerType: r.triggerType, eventType: r.eventType ?? EVENT_TYPES[0]!,
    frequency: r.schedule?.frequency ?? 'daily', time: r.schedule?.time ?? '08:00', weekdays: r.schedule?.weekdays ?? [],
    conditions: r.conditions.map((c) => ({ fact: c.fact, op: c.op, value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value) })),
    actions: r.actions.map((a): ActionRow => {
      switch (a.type) {
        case 'create_task': return { type: a.type, title: a.title, description: a.description ?? '', dueInHours: a.dueInHours === undefined ? '' : String(a.dueInHours), assigneeId: a.assigneeId ?? '' };
        case 'add_tag':
        case 'remove_tag': return { type: a.type, tagId: a.tagId };
        case 'close_tasks': return { type: a.type, onlyThisRule: a.onlyThisRule };
        case 'send_email': return { type: a.type, template: a.template };
        default: return { type: 'call_webhook', subscriptionId: a.subscriptionId };
      }
    }),
  };
}

function conditionValue(eventType: string, c: ConditionRow): string | boolean | string[] {
  if (c.op === 'in' || c.op === 'not_in') return c.value.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
  const kind = factsFor(eventType).find(([k]) => k === c.fact)?.[1];
  if (kind?.kind === 'boolean') return c.value === 'true';
  return c.value.trim();
}

/** The request body for create and update (update adds the version). Empty optional fields are left out. */
export function bodyFromForm(f: RuleForm): Record<string, unknown> {
  const event = f.triggerType === 'event';
  return {
    name: f.name.trim(),
    triggerType: f.triggerType,
    ...(event ? { eventType: f.eventType } : { schedule: { frequency: f.frequency, time: f.time, ...(f.frequency === 'weekly' ? { weekdays: [...f.weekdays].sort() } : {}) } }),
    conditions: event ? f.conditions.map((c) => ({ fact: c.fact, op: c.op, value: conditionValue(f.eventType, c) })) : [],
    actions: f.actions.map((a) => {
      switch (a.type) {
        case 'create_task':
          return {
            type: a.type, title: a.title.trim(),
            ...(a.description.trim() ? { description: a.description.trim() } : {}),
            ...(a.dueInHours.trim() ? { dueInHours: Number(a.dueInHours) } : {}),
            ...(a.assigneeId.trim() ? { assigneeId: a.assigneeId.trim() } : {}),
          };
        case 'add_tag':
        case 'remove_tag': return { type: a.type, tagId: a.tagId };
        case 'close_tasks': return { type: a.type, onlyThisRule: a.onlyThisRule };
        case 'send_email': return { type: a.type, template: a.template };
        default: return { type: a.type, subscriptionId: a.subscriptionId };
      }
    }),
  };
}

/** Message keys for what the run log shows: never free text from the API. */
export const stepKey = (s: StepView): string => `admin.automations.stepStatus.${s.status}`;
export const reasonKey = (code: string): string => `admin.automations.reasons.${code}`;
export const codeKey = (code: string): string => `admin.automations.codes.${code}`;
