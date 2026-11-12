import { describe, expect, it } from 'vitest';
import { AUTOMATION_ACTION_TYPES, AUTOMATION_EVENT_TYPES, AUTOMATION_REASON_CODES, AUTOMATION_STEP_CODES, AUTOMATION_STEP_STATUSES, automationRuleDefinitionSchema } from '@mt/shared';
import { blankAction, bodyFromForm, codeKey, emptyForm, factsFor, formFromRule, operatorsFor, reasonKey, stepKey, valuesFor } from './automations-panel';
import type { RuleView } from './automations-panel';
import { t } from './i18n';

const ID = '0190a1b2-0000-7000-8000-00000000000a';
const ID2 = '0190a1b2-0000-7000-8000-00000000000b';

describe('automation form', () => {
  it('a new form is a valid rule once a task title is typed', () => {
    const f = emptyForm();
    f.name = 'Follow up';
    f.actions = [{ ...(blankAction('create_task') as Extract<ReturnType<typeof blankAction>, { type: 'create_task' }>), title: 'Call them', dueInHours: '24' }];
    const body = bodyFromForm(f);
    expect(body).toEqual({ name: 'Follow up', triggerType: 'event', eventType: AUTOMATION_EVENT_TYPES[0], conditions: [], actions: [{ type: 'create_task', title: 'Call them', dueInHours: 24 }] });
    expect(automationRuleDefinitionSchema.safeParse(body).success).toBe(true);
  });

  it('turns condition text into the right kinds: lists, booleans and codes', () => {
    const f = emptyForm();
    f.name = 'x';
    f.eventType = 'bookings.booking.requested';
    f.conditions = [{ fact: 'packageId', op: 'in', value: `${ID}, ${ID2}` }, { fact: 'fromQuote', op: 'is', value: 'false' }, { fact: 'status', op: 'is', value: 'requested' }];
    f.actions = [{ type: 'close_tasks', onlyThisRule: true }];
    const body = bodyFromForm(f) as { conditions: unknown[] };
    expect(body.conditions).toEqual([{ fact: 'packageId', op: 'in', value: [ID, ID2] }, { fact: 'fromQuote', op: 'is', value: false }, { fact: 'status', op: 'is', value: 'requested' }]);
    expect(automationRuleDefinitionSchema.safeParse(body).success).toBe(true);
  });

  it('a schedule sends its days only when weekly, sorted, and no conditions', () => {
    const f = { ...emptyForm(), name: 'Weekly', triggerType: 'schedule' as const, frequency: 'weekly' as const, time: '07:30', weekdays: [5, 1], conditions: [{ fact: 'status', op: 'is' as const, value: 'x' }], actions: [{ type: 'close_tasks' as const, onlyThisRule: false }] };
    const body = bodyFromForm(f);
    expect(body).toMatchObject({ triggerType: 'schedule', schedule: { frequency: 'weekly', time: '07:30', weekdays: [1, 5] }, conditions: [] });
    expect(body).not.toHaveProperty('eventType');
    expect(automationRuleDefinitionSchema.safeParse(body).success).toBe(true);
  });

  it('round-trips a stored rule through the form', () => {
    const rule: RuleView = {
      id: ID, name: 'R', triggerType: 'event', eventType: 'bookings.booking.approved', enabled: false, testMode: true, version: 1, permissions: [],
      conditions: [{ fact: 'raceId', op: 'not_in', value: [ID] }, { fact: 'tagIds', op: 'has_tag', value: ID2 }],
      actions: [{ type: 'send_email', template: 'customer_notice_2' }, { type: 'add_tag', tagId: ID }, { type: 'call_webhook', subscriptionId: ID2 }, { type: 'create_task', title: 'T', description: 'D', dueInHours: 2 }],
    };
    const body = bodyFromForm(formFromRule(rule));
    expect(body).toEqual({ name: 'R', triggerType: 'event', eventType: 'bookings.booking.approved', conditions: rule.conditions, actions: rule.actions });
  });

  it('offers only the facts, operators and values the trigger has', () => {
    expect(factsFor('crm.quote.sent').map(([k]) => k)).not.toContain('tagIds');
    expect(operatorsFor('bookings.booking.requested', 'tagIds')).toEqual(['has_tag', 'lacks_tag']);
    expect(operatorsFor('bookings.booking.requested', 'fromQuote')).toEqual(['is']);
    expect(valuesFor('bookings.booking.requested', 'fromQuote')).toEqual(['true', 'false']);
    expect(valuesFor('bookings.booking.requested', 'packageId')).toBeNull();
  });
});

describe('automation copy', () => {
  it('has a label for every trigger, fact, action, status, reason and code the API can return', () => {
    for (const e of AUTOMATION_EVENT_TYPES) expect(t(`admin.automations.events.${e.replace(/\./g, '_')}`)).toBeTruthy();
    for (const e of AUTOMATION_EVENT_TYPES) for (const [k] of factsFor(e)) expect(t(`admin.automations.facts.${k}`)).toBeTruthy();
    for (const a of AUTOMATION_ACTION_TYPES) expect(t(`admin.automations.actions.${a}`)).toBeTruthy();
    for (const s of AUTOMATION_STEP_STATUSES) expect(t(stepKey({ index: 0, action: 'create_task', status: s }))).toBeTruthy();
    for (const r of AUTOMATION_REASON_CODES) expect(t(reasonKey(r))).toBeTruthy();
    for (const c of AUTOMATION_STEP_CODES) expect(t(codeKey(c))).toBeTruthy();
  });
});
