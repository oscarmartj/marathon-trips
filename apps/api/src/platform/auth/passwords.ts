import { Algorithm, hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

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
