import { AppError } from '../../platform/errors/safe-error';

// The template language (task 5.4) is deliberately tiny: {{name}} is replaced by a value, and that is all. There are no
// conditions, loops or expressions, so a template can never run anything, and a value is inserted once and never read
// again, so a customer's name containing "{{...}}" stays text.

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/** The distinct placeholder names in the text, in order of first use. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Braces that do not form a placeholder, such as "{{ first name }}" or an unclosed "{{": a typo to fix, not wording. */
export function hasMalformedBraces(text: string): boolean {
  return /\{\{|\}\}/.test(text.replace(PLACEHOLDER, ''));
}

export interface TemplateProblem {
  field: 'subject' | 'body';
  kind: 'unknown_variable' | 'malformed' | 'body_only_variable' | 'missing_variable';
  name?: string;
}

/**
 * Rules some variables carry (task 5.1): a `bodyOnly` one never goes in the subject, which is stored and shown in the
 * panel (a payment link's token must not be); a `requiredInBody` one must be in the body (an email that minted a link
 * has to carry it).
 */
export interface VariableRules {
  bodyOnly?: readonly string[];
  requiredInBody?: readonly string[];
}

/** What is wrong with the wording: placeholders not allowed, or not allowed where they are, missing ones, malformed braces. */
export function checkWording(fields: { subject?: string; body?: string }, allowed: readonly string[], rules: VariableRules = {}): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  for (const field of ['subject', 'body'] as const) {
    const text = fields[field];
    if (text === undefined) continue;
    for (const name of placeholdersOf(text)) {
      if (!allowed.includes(name)) problems.push({ field, kind: 'unknown_variable', name });
      else if (field === 'subject' && rules.bodyOnly?.includes(name)) problems.push({ field, kind: 'body_only_variable', name });
    }
    if (hasMalformedBraces(text)) problems.push({ field, kind: 'malformed' });
  }
  if (fields.body !== undefined) {
    const used = placeholdersOf(fields.body);
    for (const name of rules.requiredInBody ?? []) if (!used.includes(name)) problems.push({ field: 'body', kind: 'missing_variable', name });
  }
  return problems;
}

/**
 * Fills the placeholders in one pass. A missing value is an error, never an empty string: a customer should not get
 * "Hi ,". `singleLine` collapses line breaks in the result, so a value can never add a header to an email subject.
 */
export function fill(text: string, values: Readonly<Record<string, string>>, opts: { singleLine?: boolean } = {}): string {
  const out = text.replace(PLACEHOLDER, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new AppError('template_variable_missing', `No value for the variable ${name}`);
    return v;
  });
  return opts.singleLine ? out.replace(/\s*[\r\n]+\s*/g, ' ').trim() : out;
}
