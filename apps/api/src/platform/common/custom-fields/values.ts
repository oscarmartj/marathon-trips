import {
  CUSTOM_FILTER_OPS_BY_TYPE, DEFAULT_TEXT_MAX_LENGTH, isoDateSchema,
  type CustomFieldOption, type CustomFieldType, type CustomFieldValidation, type CustomFilter,
} from '@mt/shared';

// Pure rules for custom field values (task 7.5): checking one value against its definition, turning a value into a CSV
// cell and back, and turning a list filter into a Prisma JSON condition. No database and no request in here, so the
// rules are tested as a table. Nothing returned by these functions ever contains the value that was checked.

export type CustomValue = string | number | boolean | string[];

/** What a rule needs to know about a definition. */
export interface RuleDef {
  key: string;
  type: CustomFieldType;
  options: readonly CustomFieldOption[] | null;
  validation: CustomFieldValidation | null;
  required: boolean;
}

export type ValueResult = { ok: true; value: CustomValue } | { ok: false; code: string };

/** Numbers beyond this lose precision as JSON doubles; money-sized values do not belong in a custom field anyway. */
const MAX_ABS_NUMBER = 1e12;

const fail = (code: string): ValueResult => ({ ok: false, code });
const ok = (value: CustomValue): ValueResult => ({ ok: true, value });

/** A record's own value for a key. Never an inherited one: `held['constructor']` would be a function (the key format also refuses that name). */
export function ownValue(held: unknown, key: string): unknown {
  return held !== null && typeof held === 'object' && Object.hasOwn(held, key) ? (held as Record<string, unknown>)[key] : undefined;
}

/** True when the value means "no value": null, blank text or an empty list. */
export function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);
}

const isDate = (s: string): boolean => isoDateSchema.safeParse(s).success;

/**
 * Checks one non-blank value. `current` is the value the record holds now: an option that was retired stays valid for a
 * record that already holds it, and for no other.
 */
export function validateValue(def: RuleDef, raw: unknown, current?: unknown): ValueResult {
  const v = def.validation ?? {};
  switch (def.type) {
    case 'text': {
      if (typeof raw !== 'string') return fail('wrong_type');
      const text = raw.trim();
      if (text.length < (v.minLength ?? 0)) return fail('too_short');
      if (text.length > (v.maxLength ?? DEFAULT_TEXT_MAX_LENGTH)) return fail('too_long');
      return ok(text);
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail('wrong_type');
      if (Math.abs(raw) > MAX_ABS_NUMBER) return fail('too_large');
      if (v.integer && !Number.isInteger(raw)) return fail('not_integer');
      if (v.min !== undefined && raw < v.min) return fail('below_minimum');
      if (v.max !== undefined && raw > v.max) return fail('above_maximum');
      return ok(raw);
    }
    case 'date': {
      if (typeof raw !== 'string' || !isDate(raw)) return fail('wrong_type');
      if (v.minDate !== undefined && raw < v.minDate) return fail('before_earliest');
      if (v.maxDate !== undefined && raw > v.maxDate) return fail('after_latest');
      return ok(raw);
    }
    case 'boolean':
      return typeof raw === 'boolean' ? ok(raw) : fail('wrong_type');
    case 'select': {
      if (typeof raw !== 'string') return fail('wrong_type');
      return optionAllowed(def, raw, current === raw) ? ok(raw) : fail('unknown_option');
    }
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) return fail('wrong_type');
      const items = raw as string[];
      if (new Set(items).size !== items.length) return fail('duplicate_option');
      const held = Array.isArray(current) ? (current as unknown[]) : [];
      if (items.some((x) => !optionAllowed(def, x, held.includes(x)))) return fail('unknown_option');
      if (items.length < (v.minItems ?? 0)) return fail('too_few');
      if (v.maxItems !== undefined && items.length > v.maxItems) return fail('too_many');
      return ok([...items].sort((a, b) => optionIndex(def, a) - optionIndex(def, b)));
    }
  }
}

const optionIndex = (def: RuleDef, value: string): number => (def.options ?? []).findIndex((o) => o.value === value);

function optionAllowed(def: RuleDef, value: string, alreadyHeld: boolean): boolean {
  const option = (def.options ?? []).find((o) => o.value === value);
  return !!option && (!option.retired || alreadyHeld);
}

// ---- CSV ----

/** The cell an export writes: text as is (the CSV writer guards formulas), numbers and dates plainly, lists joined by "; ". */
export function toCsvCell(def: RuleDef, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (def.type === 'multiselect') return Array.isArray(value) ? value.join('; ') : null;
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

/**
 * The value an import reads from a cell, checked against the definition. A blank cell means "no value" (`blank: true`).
 * `current` is only used to keep a retired option that a record already holds.
 */
export function fromCsvCell(def: RuleDef, cell: string, current?: unknown): ValueResult | { ok: true; blank: true } {
  const text = cell.trim();
  if (text === '') return { ok: true, blank: true };
  switch (def.type) {
    case 'number':
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return fail('wrong_type');
      return validateValue(def, Number(text), current);
    case 'boolean':
      if (text === 'true') return validateValue(def, true, current);
      if (text === 'false') return validateValue(def, false, current);
      return fail('wrong_type');
    case 'multiselect':
      return validateValue(def, text.split(';').map((s) => s.trim()).filter((s) => s !== ''), current);
    default:
      return validateValue(def, text, current);
  }
}

// ---- Filters ----

export type JsonCondition = Record<string, unknown>;

/**
 * One list filter as a condition on the record's `customFields` column. Returns `null` when the operator does not apply
 * to the type or the value has the wrong shape (the caller answers 422). Dates compare as ISO text, which orders correctly.
 */
export function filterCondition(def: Pick<RuleDef, 'key' | 'type' | 'options'>, f: Pick<CustomFilter, 'op' | 'value'>): JsonCondition | null {
  if (!(CUSTOM_FILTER_OPS_BY_TYPE[def.type] as readonly string[]).includes(f.op)) return null;
  const path = [def.key];
  const col = (c: JsonCondition): JsonCondition => ({ customFields: { path, ...c } });
  const { op, value } = f;
  switch (def.type) {
    case 'text':
      if (typeof value !== 'string' || value === '') return null;
      return op === 'eq' ? col({ equals: value }) : col({ string_contains: value, mode: 'insensitive' });
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return col({ [op === 'eq' ? 'equals' : op]: value });
    case 'date':
      if (typeof value !== 'string' || !isDate(value)) return null;
      return col({ [op === 'eq' ? 'equals' : op]: value });
    case 'boolean':
      return typeof value === 'boolean' ? col({ equals: value }) : null;
    case 'select': {
      const known = (v: unknown): v is string => typeof v === 'string' && (def.options ?? []).some((o) => o.value === v);
      if (op === 'eq') return known(value) ? col({ equals: value }) : null;
      return Array.isArray(value) && value.length > 0 && value.every(known) ? { OR: value.map((v) => col({ equals: v })) } : null;
    }
    case 'multiselect':
      return typeof value === 'string' && (def.options ?? []).some((o) => o.value === value) ? col({ array_contains: [value] }) : null;
  }
}
