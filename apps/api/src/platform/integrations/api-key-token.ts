import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { hmacHex } from '../crypto/hmac';

/** mtk_<prefix>_<secret>: 12 base32 characters to look the key up, then 32 random bytes in base64url (task 8.4). */
export const API_KEY_TOKEN = /^mtk_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newApiKeyToken(): { token: string; prefix: string; secret: string } {
  const bytes = randomBytes(12);
  const prefix = [...bytes].map((b) => BASE32[b & 31]).join('');
  const secret = randomBytes(32).toString('base64url');
  return { token: `mtk_${prefix}_${secret}`, prefix, secret };
}

/** Domain-separated HMAC, so this hash can never be confused with another HMAC made with AUTH_HMAC_KEY. */
export const apiKeySecretHash = (hmacKey: string, prefix: string, secret: string): string => hmacHex(hmacKey, `api_key:${prefix}:${secret}`);

/** The one predicate every guard uses: does this request present credentials in an Authorization header at all? */
export function hasAuthorization(req: Pick<Request, 'headers'>): boolean {
  const v = req.headers.authorization;
  return typeof v === 'string' ? v.length > 0 : Array.isArray(v);
}

/** The prefix and secret of a well-formed `Authorization: Bearer mtk_…`, or null. */
export function parseApiKey(req: Pick<Request, 'headers'>): { prefix: string; secret: string } | null {
  const v = req.headers.authorization;
  if (typeof v !== 'string' || !v.startsWith('Bearer ')) return null;
  const m = API_KEY_TOKEN.exec(v.slice('Bearer '.length));
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}
