import type { AppConfig } from '../config/config';

type GuardConfig = Pick<AppConfig, 'APP_ENV' | 'MAIL_MODE' | 'MAIL_DEV_ALLOWLIST'>;

/**
 * Development guard (plan 4.6). Mail reaches real people only when MAIL_MODE=live AND APP_ENV=production. Anywhere
 * else MAIL_MODE=live is ignored with a warning, and an unknown value counts as "not live". Outside live mode any
 * recipient not on MAIL_DEV_ALLOWLIST is suppressed, so a task or a production copy running in staging never writes
 * to a real person.
 */
export function isLiveMail(config: GuardConfig): { live: boolean; warning?: string } {
  if (config.MAIL_MODE === 'live') {
    if (config.APP_ENV === 'production') return { live: true };
    return { live: false, warning: 'MAIL_MODE=live is ignored because APP_ENV is not production' };
  }
  return { live: false };
}

export function evaluateMailGuard(config: GuardConfig, to: string): { allowed: boolean; reason?: 'recipient_not_on_dev_allowlist' } {
  if (isLiveMail(config).live) return { allowed: true };
  const address = to.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  const entries = config.MAIL_DEV_ALLOWLIST.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  // A domain entry matches that domain exactly (not its subdomains); an entry with @ matches one address.
  const ok = address.includes('@') && entries.some((e) => (e.includes('@') ? e === address : e === domain));
  return ok ? { allowed: true } : { allowed: false, reason: 'recipient_not_on_dev_allowlist' };
}
