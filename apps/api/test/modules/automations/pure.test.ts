// Automations (task 7.4), without a database: conditions, the rule schema, schedules across time zones and daylight
// saving, and the registry that refuses any action able to move money or change permissions.
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_EVENT_TRIGGERS, automationRuleDefinitionSchema, automationScheduleSchema, automationStepSchema, triggerOf,
} from '@mt/shared';
import type { AutomationCondition } from '@mt/shared';
import { ActionRegistry, FORBIDDEN_ACTION_PERMISSIONS, isForbiddenActionPermission } from '../../../src/modules/automations/actions';
import type { ActionDef } from '../../../src/modules/automations/actions';
import { checkConditions, evaluateConditions, referencedIds } from '../../../src/modules/automations/conditions';
import { instantOfWall, latestOccurrence, localDate } from '../../../src/modules/automations/schedule';

const A = '0190a1b2-0000-7000-8000-00000000000a';
const B = '0190a1b2-0000-7000-8000-00000000000b';
const T = '0190a1b2-0000-7000-8000-0000000000aa';
const c = (fact: string, op: AutomationCondition['op'], value: AutomationCondition['value']): AutomationCondition => ({ fact, op, value });

describe('condition evaluation', () => {
  const facts = { status: 'requested', packageId: A, fromQuote: false, actorType: 'customer', tagIds: [T], editionId: null };
  it.each([
    [c('status', 'is', 'requested'), true],
    [c('status', 'is', 'approved'), false],
    [c('status', 'is_not', 'approved'), true],
    [c('status', 'is_not', 'requested'), false],
    [c('packageId', 'in', [A, B]), true],
    [c('packageId', 'in', [B]), false],
    [c('packageId', 'not_in', [B]), true],
    [c('packageId', 'not_in', [A]), false],
    [c('fromQuote', 'is', false), true],
    [c('fromQuote', 'is', true), false],
    [c('tagIds', 'has_tag', T), true],
    [c('tagIds', 'has_tag', A), false],
    [c('tagIds', 'lacks_tag', A), true],
    [c('tagIds', 'lacks_tag', T), false],
    // A fact that is unknown (null or missing) never matches is/in, and always matches is_not/not_in.
    [c('editionId', 'is', A), false],
    [c('editionId', 'is_not', A), true],
    [c('raceId', 'in', [A]), false],
    [c('raceId', 'not_in', [A]), true],
  ] as const)('%j → %s', (cond, expected) => {
    expect(evaluateConditions([cond], facts)).toEqual([expected]);
  });

  it('no conditions always run; every condition is reported in order', () => {
    expect(evaluateConditions([], facts)).toEqual([]);
    expect(evaluateConditions([c('status', 'is', 'requested'), c('fromQuote', 'is', true)], facts)).toEqual([true, false]);
  });
});

describe('condition checks against the trigger', () => {
  const ok = (type: string, conds: AutomationCondition[]) => () => checkConditions(type, conds);
  it('accepts facts, operators and values the trigger offers', () => {
    expect(ok('bookings.booking.requested', [c('status', 'in', ['requested', 'approved']), c('tagIds', 'lacks_tag', T), c('fromQuote', 'is', true), c('actorType', 'is', 'customer')])).not.toThrow();
    expect(ok('catalogue.package.sale_status_changed', [c('toStatus', 'is', 'open'), c('raceId', 'is', A)])).not.toThrow();
  });
  it.each([
    ['bookings.booking.requested', c('toStatus', 'is', 'open'), 'a fact of another trigger'],
    ['crm.quote.sent', c('tagIds', 'has_tag', T), 'tags on quotes'],
    ['bookings.booking.requested', c('status', 'has_tag', T), 'an operator the fact does not take'],
    ['bookings.booking.requested', c('fromQuote', 'in', ['true']), 'a list on a boolean'],
    ['bookings.booking.requested', c('status', 'is', 'paid_in_full'), 'an enum value that does not exist'],
    ['bookings.booking.requested', c('packageId', 'is', 'open'), 'a code where an id goes'],
    ['bookings.booking.requested', c('packageId', 'is', [A]), 'a list for is'],
    ['bookings.booking.requested', c('status', 'in', 'requested'), 'a single value for in'],
  ])('%s: refuses %s (%s)', (type, cond) => {
    expect(ok(type, [cond])).toThrow(expect.objectContaining({ code: 'automation_condition_invalid' }));
  });
  it('a scheduled rule has no conditions; an unknown trigger is refused', () => {
    expect(() => checkConditions(null, [c('status', 'is', 'requested')])).toThrow(expect.objectContaining({ code: 'automation_condition_invalid' }));
    expect(() => checkConditions('payments.payment.succeeded', [])).toThrow(expect.objectContaining({ code: 'automation_trigger_unknown' }));
  });
  it('collects referenced ids by kind for the database check', () => {
    expect(referencedIds('bookings.booking.requested', [c('packageId', 'in', [A, B]), c('raceId', 'is', A), c('tagIds', 'has_tag', T)])).toEqual({ package: [A, B], edition: [], race: [A], tag: [T] });
  });
});

describe('rule schema', () => {
  const base = { name: 'Follow up', triggerType: 'event', eventType: 'bookings.booking.requested', conditions: [], actions: [{ type: 'create_task', title: 'Call them' }] };
  const parse = (over: Record<string, unknown>) => automationRuleDefinitionSchema.safeParse({ ...base, ...over });
  it('accepts every action kind', () => {
    for (const a of [
      { type: 'create_task', title: 'T', description: 'D', dueInHours: 24, assigneeId: A }, { type: 'add_tag', tagId: T }, { type: 'remove_tag', tagId: T },
      { type: 'close_tasks' }, { type: 'send_email', template: 'customer_notice_1' }, { type: 'call_webhook', subscriptionId: A },
    ]) expect(parse({ actions: [a] }).success, JSON.stringify(a)).toBe(true);
  });
  it.each([
    [{ actions: [{ type: 'change_booking_status', to: 'approved' }] }, 'a booking transition'],
    [{ actions: [{ type: 'refund', amountMinor: 100 }] }, 'money'],
    [{ actions: [{ type: 'grant_role', roleId: A }] }, 'permissions'],
    [{ actions: [{ type: 'call_webhook', url: 'https://example.test' }] }, 'a free webhook address'],
    [{ actions: [{ type: 'create_task', title: 'x', extra: 1 }] }, 'an unknown field'],
    [{ actions: [] }, 'no action'],
    [{ actions: Array.from({ length: 11 }, () => ({ type: 'close_tasks' })) }, 'more than ten actions'],
    [{ conditions: Array.from({ length: 11 }, () => c('status', 'is', 'requested')) }, 'more than ten conditions'],
    [{ eventType: 'payments.payment.succeeded' }, 'a money event as trigger'],
    [{ eventType: 'access.role.changed' }, 'an access event as trigger'],
    [{ eventType: 'automations.run.completed' }, 'its own event as trigger'],
    [{ triggerType: 'schedule' }, 'a schedule rule without schedule'],
    [{ triggerType: 'schedule', eventType: undefined, schedule: { frequency: 'daily', time: '08:00' }, conditions: [c('status', 'is', 'requested')] }, 'a schedule with conditions'],
    [{ schedule: { frequency: 'daily', time: '08:00' } }, 'an event rule with a schedule'],
    [{ name: ' ' }, 'a blank name'],
    [{ actions: [{ type: 'send_email', template: 'marketing_blast' }] }, 'an unknown template'],
  ])('refuses %j (%s)', (over) => {
    expect(parse(over).success).toBe(false);
  });
  it.each([
    [{ frequency: 'daily', time: '08:00' }, true], [{ frequency: 'weekly', time: '23:55', weekdays: [1, 5] }, true],
    [{ frequency: 'daily', time: '08:03' }, false], [{ frequency: 'daily', time: '24:00' }, false], [{ frequency: 'weekly', time: '08:00' }, false],
    [{ frequency: 'weekly', time: '08:00', weekdays: [1, 1] }, false], [{ frequency: 'daily', time: '08:00', weekdays: [1] }, false],
    [{ frequency: 'hourly', time: '08:00' }, false], [{ frequency: 'weekly', time: '08:00', weekdays: [8] }, false],
  ])('schedule %j valid=%s', (s, valid) => {
    expect(automationScheduleSchema.safeParse(s).success).toBe(valid);
  });
  it('a stored step holds codes and ids only', () => {
    expect(automationStepSchema.safeParse({ index: 0, action: 'create_task', status: 'done', entityType: 'Task', entityId: A }).success).toBe(true);
    expect(automationStepSchema.safeParse({ index: 0, action: 'create_task', status: 'failed', code: 'Connection refused by 10.0.0.1' }).success).toBe(false);
    expect(automationStepSchema.safeParse({ index: 0, action: 'create_task', status: 'done', title: 'Call Ada' }).success).toBe(false);
  });
  it('every trigger names a record type with facts', () => {
    for (const [type, t] of Object.entries(AUTOMATION_EVENT_TRIGGERS)) {
      expect(triggerOf(type)).toBe(t);
      expect(Object.keys(t.facts).length).toBeGreaterThan(0);
    }
  });
});

describe('schedules', () => {
  const at = (iso: string) => new Date(iso);
  it('daily in Brisbane (no daylight saving): the latest occurrence at or before now', () => {
    const s = { frequency: 'daily', time: '08:00' } as const;
    expect(latestOccurrence(s, at('2026-11-12T22:00:00Z'), 'Australia/Brisbane')?.toISOString()).toBe('2026-11-12T22:00:00.000Z'); // 08:00 on the 13th
    expect(latestOccurrence(s, at('2026-11-12T21:59:00Z'), 'Australia/Brisbane')?.toISOString()).toBe('2026-11-11T22:00:00.000Z');
  });
  it('weekly only on the chosen weekdays', () => {
    const s = { frequency: 'weekly', time: '09:30', weekdays: [1] } as const; // Mondays
    // Friday 13 November 2026 in Brisbane: the last Monday was the 9th.
    expect(latestOccurrence(s, at('2026-11-13T05:00:00Z'), 'Australia/Brisbane')?.toISOString()).toBe('2026-11-08T23:30:00.000Z');
  });
  it('Sydney spring forward: 02:30 does not exist and moves forward by the gap', () => {
    // 4 October 2026, 02:00 AEST becomes 03:00 AEDT (16:00 UTC on the 3rd).
    const wall = Date.parse('2026-10-04T02:30:00Z');
    expect(new Date(instantOfWall(wall, 'Australia/Sydney')).toISOString()).toBe('2026-10-03T16:30:00.000Z'); // 03:30 AEDT
    const s = { frequency: 'daily', time: '02:30' } as const;
    expect(latestOccurrence(s, at('2026-10-03T17:00:00Z'), 'Australia/Sydney')?.toISOString()).toBe('2026-10-03T16:30:00.000Z');
  });
  it('Sydney fall back: 02:30 happens twice and fires at the earlier instant', () => {
    // 5 April 2026, 03:00 AEDT becomes 02:00 AEST (16:00 UTC on the 4th).
    const wall = Date.parse('2026-04-05T02:30:00Z');
    expect(new Date(instantOfWall(wall, 'Australia/Sydney')).toISOString()).toBe('2026-04-04T15:30:00.000Z'); // 02:30 AEDT, the first one
  });
  it('local dates follow the zone', () => {
    expect(localDate(at('2026-11-12T15:00:00Z'), 'Australia/Brisbane')).toBe('2026-11-13');
    expect(localDate(at('2026-11-12T13:00:00Z'), 'Australia/Brisbane')).toBe('2026-11-12');
  });
});

describe('registering_money_or_permission_action_fails', () => {
  const action = (over: Partial<ActionDef>): ActionDef => ({
    type: 'create_task', movesMoney: false, changesPermissions: false, declaredPermissions: ['common.task.write'], allowedOn: ['Booking'],
    permissions: () => ['common.task.write'], validate: async () => undefined, run: async () => ({ status: 'done' }), ...over,
  });
  it.each([
    [{ movesMoney: true }, 'flagged as moving money'],
    [{ changesPermissions: true }, 'flagged as changing permissions'],
    [{ declaredPermissions: ['payments.refund.create'] }, 'payments'],
    [{ declaredPermissions: ['finance.report.read'] }, 'finance'],
    [{ declaredPermissions: ['pricing.priceVersion.publish'] }, 'prices'],
    [{ declaredPermissions: ['changes.amendment.apply'] }, 'booking changes'],
    [{ declaredPermissions: ['access.role.manage'] }, 'roles'],
    [{ declaredPermissions: ['access.user.manage'] }, 'staff accounts'],
    [{ declaredPermissions: ['audit.log.read'] }, 'audit'],
    [{ declaredPermissions: ['platform.flag.manage'] }, 'flags'],
    [{ declaredPermissions: ['platform.setting.manageFinancial'] }, 'financial settings'],
    [{ declaredPermissions: ['integrations.apiKey.manage'] }, 'API keys'],
    [{ declaredPermissions: ['automations.rule.enable'] }, 'other automations'],
    [{ declaredPermissions: ['bookings.booking.approve'] }, 'approving'],
    [{ declaredPermissions: ['bookings.booking.decline'] }, 'declining'],
    [{ declaredPermissions: ['bookings.booking.cancel'] }, 'cancelling'],
  ])('refuses an action %j (%s)', (over) => {
    expect(() => new ActionRegistry().register(action(over))).toThrow(expect.objectContaining({ code: 'automation_action_forbidden' }));
  });
  it('accepts a harmless action once, and an action asking for an undeclared permission fails when used', () => {
    const r = new ActionRegistry();
    r.register(action({}));
    expect(() => r.register(action({}))).toThrow(expect.objectContaining({ code: 'automation_action_duplicate' }));
    const sneaky = new ActionRegistry();
    sneaky.register(action({ permissions: () => ['payments.refund.create'] }));
    expect(() => sneaky.permissionsOf({ type: 'create_task', title: 'x' }, 'Booking')).toThrow(expect.objectContaining({ code: 'automation_action_forbidden' }));
  });
  it('the forbidden list covers money and permission modules', () => {
    for (const k of ['payments.x.y', 'finance.x.y', 'pricing.x.y', 'access.x.y', 'platform.x.y', 'bookings.booking.cancel']) expect(isForbiddenActionPermission(k)).toBe(true);
    for (const k of ['common.task.write', 'bookings.booking.annotate', 'bookings.customer.read', 'integrations.webhook.manage']) expect(isForbiddenActionPermission(k)).toBe(false);
    expect(FORBIDDEN_ACTION_PERMISSIONS.length).toBeGreaterThan(0);
  });
});
