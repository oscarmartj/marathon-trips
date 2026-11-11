import { randomBytes } from 'node:crypto';
import { hmacHex, sha256Hex } from '../crypto/hmac';

/** 32 random bytes, base64url: sessions, magic links, MFA steps and enrolment links. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Tokens have 256 bits of entropy, so a plain SHA-256 is enough to store them (plan 4.2). */
export const tokenHash = (token: string): string => sha256Hex(`token:${token}`);

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const looksLikeToken = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Recovery code: 16 Crockford base32 characters (80 bits) shown as XXXX-XXXX-XXXX-XXXX. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => CROCKFORD[b & 31]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** Normalises what the user typed (case, dashes, spaces, O/I/L confusions) before hashing. */
export function normaliseRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export const recoveryCodeHash = (key: string, code: string): string => hmacHex(key, `recovery:${normaliseRecoveryCode(code)}`);
