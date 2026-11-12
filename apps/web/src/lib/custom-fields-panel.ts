import { CUSTOM_FILTER_OPS_BY_TYPE, CUSTOM_FIELD_OPTION_VALUE, type CustomFieldDefinitionView, type CustomFieldOption, type CustomFieldType, type CustomFilter } from '@mt/shared';
import { MAIN_LOCALE, enAU, withEnAU } from './catalogue-panel';

// Pure helpers for custom fields in the panel (task 7.5): turning stored values into form state and back, building list
// filters, and reading the option lines of the settings page. The API checks every value again; nothing here is trusted.

export type CustomFieldDef = CustomFieldDefinitionView;
/** Form state of one field: text as typed, a yes/no/not set choice as '', 'true' or 'false', a multiselect as a list. */
export type FormValue = string | string[];
export type FormValues = Record<string, FormValue>;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The label staff see for a field, in en-AU, falling back to the key. */
export const fieldLabel = (d: Pick<CustomFieldDef, 'label' | 'key'>): string => enAU(d.label) || d.key;

/** Options offered for a new choice: retired ones are only listed while the record still holds them. */
export function offeredOptions(d: Pick<CustomFieldDef, 'options'>, held: FormValue | undefined): CustomFieldOption[] {
  const keep = new Set(Array.isArray(held) ? held : held ? [held] : []);
  return (d.options ?? []).filter((o) => !o.retired || keep.has(o.value));
}

/** Form state for a record: what it stores now, or empty. */
export function initialValues(defs: readonly CustomFieldDef[], stored: unknown): FormValues {
  const held = isRecord(stored) ? stored : {};
  const out: FormValues = {};
  for (const d of defs) {
    const v = held[d.key];
    if (d.type === 'multiselect') out[d.key] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    else if (v === undefined || v === null) out[d.key] = '';
    else out[d.key] = String(v);
  }
  return out;
}

type Parsed = string | number | boolean | string[] | null;

/** One field's form state as the value the API takes: null for "no value". A number that is not a number is `undefined` (invalid). */
export function parseValue(d: Pick<CustomFieldDef, 'type'>, raw: FormValue | undefined): Parsed | undefined {
  if (d.type === 'multiselect') return Array.isArray(raw) && raw.length > 0 ? raw : null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return null;
  switch (d.type) {
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined;
      return Number(text);
    }
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : undefined;
    default:
      return text;
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The `customFields` patch to send. On a new record every field with a value; on an existing one only the fields that
 * changed (a cleared field is null, which removes it). `undefined` when there is nothing to send. `invalid` lists the keys
 * whose text could not be read, so the form can say so before the API does.
 */
export function customFieldPatch(defs: readonly CustomFieldDef[], form: FormValues, stored: unknown, creating: boolean): { patch: Record<string, Parsed> | undefined; invalid: string[] } {
  const held = isRecord(stored) ? stored : {};
  const patch: Record<string, Parsed> = {};
  const invalid: string[] = [];
  for (const d of defs) {
    const parsed = parseValue(d, form[d.key]);
    if (parsed === undefined) {
      invalid.push(d.key);
      continue;
    }
    if (creating ? parsed !== null : !same(parsed, held[d.key])) patch[d.key] = parsed;
  }
  return { patch: Object.keys(patch).length > 0 ? patch : undefined, invalid };
}

// ---- Filters ----

export const filterOps = (type: CustomFieldType): readonly string[] => CUSTOM_FILTER_OPS_BY_TYPE[type];

/** A filter from what was typed or picked, or null when the value cannot be read (the filter is left off). */
export function buildFilter(d: Pick<CustomFieldDef, 'key' | 'type'>, op: string, raw: string): CustomFilter | null {
  if (!(filterOps(d.type) as readonly string[]).includes(op)) return null;
  const text = raw.trim();
  if (text === '') return null;
  let value: CustomFilter['value'];
  if (d.type === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
    value = Number(text);
  } else if (d.type === 'boolean') {
    if (text !== 'true' && text !== 'false') return null;
    value = text === 'true';
  } else if (d.type === 'select' && op === 'in') {
    value = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (value.length === 0) return null;
  } else value = text;
  return { key: d.key, op: op as CustomFilter['op'], value };
}

/** The `cf` query parameter for a list, or null for no filter. */
export const filterParam = (filters: readonly CustomFilter[]): string | null => (filters.length > 0 ? JSON.stringify(filters) : null);

// ---- Settings: options as lines ----

/** One option per line: `value | Label`, with `| retired` after the label for a retired option. */
export function optionLines(options: readonly CustomFieldOption[] | null | undefined): string {
  return (options ?? []).map((o) => `${o.value} | ${enAU(o.label)}${o.retired ? ' | retired' : ''}`).join('\n');
}

export type OptionsResult = { ok: true; options: CustomFieldOption[] } | { ok: false; code: 'format' | 'value' | 'duplicate' | 'empty' };

/** Reads the lines back. Labels in other languages already on an option are kept. */
export function parseOptionLines(text: string, previous: readonly CustomFieldOption[] | null | undefined = []): OptionsResult {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return { ok: false, code: 'empty' };
  const options: CustomFieldOption[] = [];
  for (const line of lines) {
    const parts = line.split('|').map((p) => p.trim());
    const [value, label, flag] = parts;
    if (parts.length < 2 || parts.length > 3 || !value || !label || (flag !== undefined && flag !== 'retired')) return { ok: false, code: 'format' };
    if (!CUSTOM_FIELD_OPTION_VALUE.test(value)) return { ok: false, code: 'value' };
    if (options.some((o) => o.value === value)) return { ok: false, code: 'duplicate' };
    const before = (previous ?? []).find((o) => o.value === value);
    options.push({ value, label: withEnAU(before?.label, label), ...(flag === 'retired' ? { retired: true } : {}) });
  }
  return { ok: true, options };
}

/** Keeps the key readable: lower case, digits and underscores, starting with a letter. */
export function suggestKey(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (/^[a-z]/.test(base) ? base : base ? `f_${base}` : '').slice(0, 40).replace(/_+$/, '');
}

export { MAIN_LOCALE };

// ---- Settings: definition forms ----

/** Record types whose custom fields a customer can see; the API enforces the same rule. */
export const CUSTOMER_VISIBLE_ENTITIES: readonly string[] = ['Race', 'Package'];

type RuleKey = 'minLength' | 'maxLength' | 'min' | 'max' | 'integer' | 'minDate' | 'maxDate' | 'minItems' | 'maxItems';
/** The limits each type takes, in the order the form shows them. */
export const RULE_KEYS: Record<CustomFieldType, readonly RuleKey[]> = {
  text: ['minLength', 'maxLength'], number: ['min', 'max', 'integer'], date: ['minDate', 'maxDate'], boolean: [], select: [], multiselect: ['minItems', 'maxItems'],
};
const WHOLE: readonly RuleKey[] = ['minLength', 'maxLength', 'minItems', 'maxItems'];

export type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; code: 'rule' | 'options' | 'key' | 'label' };

/** The limits typed in a form, for the given type only. Empty boxes are left out. */
export function readRules(type: CustomFieldType, v: Record<string, string | boolean>): { ok: true; rules: Record<string, number | boolean | string> } | { ok: false } {
  const rules: Record<string, number | boolean | string> = {};
  for (const key of RULE_KEYS[type]) {
    const raw = v[key];
    if (key === 'integer') {
      if (raw === true) rules.integer = true;
      continue;
    }
    const text = String(raw ?? '').trim();
    if (text === '') continue;
    if (key === 'minDate' || key === 'maxDate') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false };
      rules[key] = text;
    } else if (WHOLE.includes(key)) {
      if (!/^\d{1,4}$/.test(text)) return { ok: false };
      rules[key] = Number(text);
    } else {
      if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false };
      rules[key] = Number(text);
    }
  }
  return { ok: true, rules };
}

const isSelect = (t: CustomFieldType) => t === 'select' || t === 'multiselect';

/** The body for creating a definition from the settings form. */
export function definitionBody(v: Record<string, string | boolean>, entityType: string): BodyResult {
  const type = String(v.type) as CustomFieldType;
  const label = String(v.label ?? '').trim();
  const key = String(v.key ?? '').trim() || suggestKey(label);
  if (!label) return { ok: false, code: 'label' };
  if (!key) return { ok: false, code: 'key' };
  const rules = readRules(type, v);
  if (!rules.ok) return { ok: false, code: 'rule' };
  const body: Record<string, unknown> = {
    entityType, key, label: withEnAU(undefined, label), type, required: v.required === true,
    visibleToCustomer: CUSTOMER_VISIBLE_ENTITIES.includes(entityType) && v.visibleToCustomer === true, editableByCustomer: false,
    displayOrder: wholeOrZero(String(v.displayOrder ?? '')),
  };
  if (Object.keys(rules.rules).length > 0) body.validation = rules.rules;
  if (isSelect(type)) {
    const options = parseOptionLines(String(v.options ?? ''));
    if (!options.ok) return { ok: false, code: 'options' };
    body.options = options.options;
  }
  return { ok: true, body };
}

/** The body for changing a definition: the label, flags, order, options and limits. Key and type are not here. */
export function updateDefinitionBody(def: CustomFieldDef, v: Record<string, string | boolean>): BodyResult {
  const label = String(v.label ?? '').trim();
  if (!label) return { ok: false, code: 'label' };
  const rules = readRules(def.type, v);
  if (!rules.ok) return { ok: false, code: 'rule' };
  const body: Record<string, unknown> = {
    label: withEnAU(def.label, label), required: v.required === true,
    visibleToCustomer: CUSTOMER_VISIBLE_ENTITIES.includes(def.entityType) && v.visibleToCustomer === true,
    displayOrder: wholeOrZero(String(v.displayOrder ?? '')), version: def.version,
  };
  if (RULE_KEYS[def.type].length > 0) body.validation = rules.rules;
  if (isSelect(def.type)) {
    const options = parseOptionLines(String(v.options ?? ''), def.options);
    if (!options.ok) return { ok: false, code: 'options' };
    body.options = options.options;
  }
  return { ok: true, body };
}

/** Form values for editing a definition. */
export function definitionFormValues(def: CustomFieldDef): Record<string, string | boolean> {
  const v: Record<string, string | boolean> = {
    label: enAU(def.label), required: def.required, visibleToCustomer: def.visibleToCustomer, displayOrder: String(def.displayOrder), options: optionLines(def.options),
  };
  for (const key of RULE_KEYS[def.type]) {
    const r = def.validation?.[key];
    v[key] = key === 'integer' ? r === true : r === undefined ? '' : String(r);
  }
  return v;
}

function wholeOrZero(text: string): number {
  return /^\d{1,4}$/.test(text.trim()) ? Math.min(1000, Number(text)) : 0;
}
