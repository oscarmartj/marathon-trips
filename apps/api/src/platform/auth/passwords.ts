import { Algorithm, hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { COMMON_PASSWORDS } from './common-passwords.generated';

// OWASP minimum for argon2id: 19 MiB, 2 iterations, parallelism 1.
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

/** Verified against when an account does not exist or has no password, so timing does not reveal either (T2). */
let decoy: Promise<string> | null = null;
const decoyHash = (): Promise<string> => (decoy ??= hash(randomBytes(32).toString('hex'), OPTIONS));

/** Always runs one argon2 verification, whether or not there is a hash. */
export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  const target = stored ?? (await decoyHash());
  let ok = false;
  try {
    ok = await verify(target, password);
  } catch {
    ok = false;
  }
  return ok && !!stored;
}

const COMMON = new Set(COMMON_PASSWORDS);

/** Every character one step after the previous (abcdef…, 123456…, 987654…) or all the same: trivially guessable. */
function isRun(s: string): boolean {
  const codes = [...s].map((c) => c.charCodeAt(0));
  // Digits wrap round (…7890…, …3210987…), as people type them.
  const digits = /^\d+$/.test(s);
  const steps = new Set(codes.slice(1).map((c, i) => (digits ? (c - codes[i]! + 10) % 10 : c - codes[i]!)));
  return steps.size === 1 && [...steps].every((d) => (digits ? d === 0 || d === 1 || d === 9 : d >= -1 && d <= 1));
}

/**
 * Task 8.5 (ASVS 5.0 6.2.4, 6.2.11): a password that meets the length rule but is still easy to guess. Checked against
 * the common-password list (offline, no third party sees the password), runs and repeats, and the words of this
 * service: its name and the account's own address. Only the length is a composition rule (6.2.5).
 */
export function guessablePassword(password: string, context: { email: string; brandName: string }): boolean {
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || isRun(lower)) return true;
  const letters = lower.replace(/[^a-z]/g, '');
  const local = context.email.toLowerCase().split('@')[0]!.replace(/[^a-z]/g, '');
  const brand = context.brandName.toLowerCase().replace(/[^a-z]/g, '');
  return letters.length > 0 && (letters === brand || (local.length >= 4 && letters === local) || COMMON.has(letters));
}
