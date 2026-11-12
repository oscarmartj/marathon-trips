import { OPERATORS_BY_KIND, triggerOf } from '@mt/shared';
import type { AutomationCondition, AutomationFacts, FactKind } from '@mt/shared';
import { unprocessable } from '../../platform/http/api-error';

// Conditions of a rule (task 7.4): pure checks and evaluation. All conditions must hold. Error messages name the
// position of a condition, never a value.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_OPS = new Set(['in', 'not_in']);

function valueFits(kind: FactKind, op: string, value: unknown): boolean {
  const one = (v: unknown): boolean => {
    if (kind.kind === 'uuid' || kind.kind === 'tags') return typeof v === 'string' && UUID.test(v);
    if (kind.kind === 'enum') return typeof v === 'string' && kind.values.includes(v);
    return typeof v === 'boolean';
  };
  if (LIST_OPS.has(op)) return Array.isArray(value) && value.length > 0 && value.every(one);
  return !Array.isArray(value) && one(value);
}

/** Throws 422 `automation_condition_invalid` unless every condition uses a fact, operator and value the trigger allows. */
export function checkConditions(eventType: string | null, conditions: readonly AutomationCondition[]): void {
  if (!eventType) {
    if (conditions.length > 0) throw unprocessable('automation_condition_invalid', 'A scheduled rule has no conditions');
    return;
  }
  const trigger = triggerOf(eventType);
  if (!trigger) throw unprocessable('automation_trigger_unknown', 'That event cannot start an automation');
  conditions.forEach((c, i) => {
    const kind = trigger.facts[c.fact];
    if (!kind) throw unprocessable('automation_condition_invalid', `Condition ${i + 1} tests something this trigger does not offer`);
    if (!OPERATORS_BY_KIND[kind.kind].includes(c.op)) throw unprocessable('automation_condition_invalid', `Condition ${i + 1} uses a comparison this field does not allow`);
    if (!valueFits(kind, c.op, c.value)) throw unprocessable('automation_condition_invalid', `Condition ${i + 1} has a value of the wrong kind`);
  });
}

/** Ids a rule's conditions refer to, by what they are (checked against the database when the rule is saved). */
export function referencedIds(eventType: string | null, conditions: readonly AutomationCondition[]): { package: string[]; edition: string[]; race: string[]; tag: string[] } {
  const out = { package: [] as string[], edition: [] as string[], race: [] as string[], tag: [] as string[] };
  const trigger = eventType ? triggerOf(eventType) : undefined;
  if (!trigger) return out;
  for (const c of conditions) {
    const kind = trigger.facts[c.fact];
    const values = (Array.isArray(c.value) ? c.value : [c.value]).filter((v): v is string => typeof v === 'string');
    if (kind?.kind === 'uuid') out[kind.ref].push(...values);
    if (kind?.kind === 'tags') out.tag.push(...values);
  }
  return out;
}

/** One result per condition, in order. A missing fact never matches `is` or `in`, and always matches `is_not` and `not_in`. */
export function evaluateConditions(conditions: readonly AutomationCondition[], facts: AutomationFacts): boolean[] {
  return conditions.map((c) => {
    const have = facts[c.fact];
    switch (c.op) {
      case 'is': return have === c.value;
      case 'is_not': return have !== c.value;
      case 'in': return Array.isArray(c.value) && (c.value as unknown[]).includes(have);
      case 'not_in': return Array.isArray(c.value) && !(c.value as unknown[]).includes(have);
      case 'has_tag': return Array.isArray(have) && have.includes(c.value as string);
      case 'lacks_tag': return !(Array.isArray(have) && have.includes(c.value as string));
      default: return false;
    }
  });
}
