import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export const hmacHex = (key: string, data: string): string => createHmac('sha256', key).update(data).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Lower-cases and trims, so one address always gives one hash. */
export const emailHash = (key: string, email: string): string => hmacHex(key, `email:${email.trim().toLowerCase()}`);

/** Unsubscribe links carry an HMAC of the email id, never a stored token (plan 4.6). */
export const unsubscribeToken = (key: string, outboundEmailId: string): string => hmacHex(key, `unsubscribe:${outboundEmailId}`);

/** Canonical JSON (sorted keys) so equal bodies hash equally whatever the key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
