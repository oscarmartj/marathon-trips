import { AppError } from '../errors/safe-error';

// Event payloads and job data carry identifiers only (plan 4.5): no personal data, no calculated amounts, no secrets.
const FORBIDDEN_KEY =
  /e-?mail|phone|mobile|name|address|birth|dob|passport|password|secret|token|card|iban|amount|price|total|currency|minor/i;

/** Returns the dotted paths of keys that look like personal data, amounts or secrets. */
export function forbiddenKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const here = path ? `${path}.${k}` : k;
      // Keys ending in Id or Ids hold identifiers (outboundEmailId), whatever words they contain.
      const forbidden = FORBIDDEN_KEY.test(k) && !/Ids?$/.test(k);
      return [...(forbidden ? [here] : []), ...forbiddenKeys(v, here)];
    });
  }
  return [];
}

export function assertIdentifiersOnly(kind: 'event payload' | 'job data', value: unknown): void {
  const bad = forbiddenKeys(value);
  if (bad.length > 0) {
    // Only key names are reported, never values.
    throw new AppError('payload_not_identifiers_only', `${kind} must carry identifiers only; offending keys: ${bad.join(', ')}`);
  }
}
