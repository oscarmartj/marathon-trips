import { Secret, TOTP } from 'otpauth';

export const TOTP_PERIOD = 30;
const ISSUER = 'Marathon Trips';

const totp = (secretBase32: string, label = 'staff'): TOTP =>
  new TOTP({ issuer: ISSUER, label, algorithm: 'SHA1', digits: 6, period: TOTP_PERIOD, secret: Secret.fromBase32(secretBase32) });

/** 160-bit secret (RFC 4226 recommendation), base32 for authenticator apps. */
export const newTotpSecret = (): string => new Secret({ size: 20 }).base32;

export const totpUri = (secretBase32: string, email: string): string => totp(secretBase32, email).toString();

export const currentStep = (now: number = Date.now()): number => Math.floor(now / 1000 / TOTP_PERIOD);

/**
 * Returns the time step the code belongs to (window ±1 step), or null. The caller must then store the step with a
 * compare-and-set so the same code is never accepted twice (plan 4.2).
 */
export function verifyTotp(secretBase32: string, code: string, now: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totp(secretBase32).validate({ token: code, timestamp: now, window: 1 });
  return delta === null ? null : currentStep(now) + delta;
}

/** For tests, the seed and the e2e set-up: the code for a time. */
export const totpCode = (secretBase32: string, now: number = Date.now()): string => totp(secretBase32).generate({ timestamp: now });
