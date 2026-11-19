// Pure rules for gateway accounts managed from the panel (task 4.1, plan docs/plans/4.1-provider-accounts-panel.md).
// No database and no secrets: what may be created, which status follows which, how typed credentials are checked and
// what blocks archiving. Table-tested in provider-accounts.unit.test.ts.
import type { AppEnv } from '@mt/shared';
import { TEST_ADAPTER_ENVS, modeForEnv } from './gateway';
import type { AccountSetup, AdapterManifest } from './provider';

export type AccountStatus = 'active' | 'paused' | 'retired' | 'archived';

/** Every allowed status change (plan 0.1, 6.4). Migration 0034's trigger holds the same list (checked by a test). */
export const PROVIDER_ACCOUNT_STATUS_PAIRS: ReadonlyArray<readonly [AccountStatus, AccountStatus]> = [
  ['active', 'paused'],
  ['paused', 'active'],
  ['active', 'retired'],
  ['paused', 'retired'],
  ['retired', 'archived'],
];

export const allowedTransitions = (from: AccountStatus): AccountStatus[] => PROVIDER_ACCOUNT_STATUS_PAIRS.filter(([f]) => f === from).map(([, t]) => t);
export const transitionAllowed = (from: AccountStatus, to: AccountStatus): boolean => PROVIDER_ACCOUNT_STATUS_PAIRS.some(([f, t]) => f === from && t === to);

/**
 * Why an account of `manifest` in `mode` cannot be created here (plan 4.1, 4.1 step 1), or null. Live first and in
 * every environment: `CHECK (mode = 'test')` stays until a later task lifts it (plan 4.1, section 14).
 */
export function creationBlockReason(manifest: AdapterManifest | undefined, mode: string, env: AppEnv): string | null {
  if (mode !== 'test') return 'live_mode_not_available';
  if (!manifest) return 'adapter_unknown';
  if (manifest.status === 'planned') return 'adapter_unavailable';
  if (modeForEnv(env) !== 'test') return 'account_mode_not_for_environment';
  if (manifest.testOnly && !TEST_ADAPTER_ENVS.includes(env)) return 'test_adapter_blocked_in_environment';
  return null;
}

const MAX_VALUE = 500;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** How an unknown key is reported: never by its name, which the client chose and could be a secret (plan 4.1, 15.6). */
export const UNKNOWN_FIELD = '(unknown)';

export type CredentialCheck = { ok: true; values: Record<string, string> } | { ok: false; fields: string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function valueProblem(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE || CONTROL.test(value)) return true;
  return !new RegExp(pattern).test(value);
}

/**
 * Checks typed credentials against the adapter's descriptor. `partial`: only the keys sent are checked and at least one
 * is needed (a change); otherwise every field is required (a new account). The answer names field keys only.
 */
export function checkCredentials(setup: AccountSetup, input: unknown, opts: { partial: boolean }): CredentialCheck {
  if (!isPlainObject(input)) return { ok: false, fields: ['credentials'] };
  const fields = new Map(setup.fields.map((f) => [f.key, f]));
  const bad = new Set<string>();
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const f = fields.get(key);
    if (!f) {
      bad.add(UNKNOWN_FIELD);
      continue;
    }
    if (valueProblem(value, f.pattern)) bad.add(key);
    else values[key] = value as string;
  }
  if (!opts.partial) for (const key of fields.keys()) if (!(key in input)) bad.add(key);
  if (opts.partial && Object.keys(input).length === 0) bad.add('credentials');
  return bad.size > 0 ? { ok: false, fields: [...bad].sort() } : { ok: true, values };
}

/** Checks an entered webhook secret; false when the adapter makes its own or the value does not match. */
export function webhookSecretValid(setup: AccountSetup, value: unknown): value is string {
  if (setup.webhookSecret.source !== 'entered') return false;
  return !valueProblem(value, setup.webhookSecret.pattern);
}

/**
 * Whether a secrets change may be stored after its candidate test (plan 4.1, 4.4): an `ok` test, or — while the account
 * still has no webhook secret and the change does not set one — `webhook_secret_missing`, which Stripe reports only after
 * the key itself was accepted. Without that exception a wrong key and a missing secret could never be fixed one by one.
 */
export function secretsChangeAcceptable(result: string, opts: { setsWebhookSecret: boolean; hasWebhookSecret: boolean }): boolean {
  if (result === 'ok') return true;
  return result === 'webhook_secret_missing' && !opts.setsWebhookSecret && !opts.hasWebhookSecret;
}

/** Whether the stored connection test is `ok` and covers the current credentials (plan 4.1, 4.3 and 15.1). */
export function connectionTestCurrent(a: { lastConnectionTestResult: string | null; lastConnectionTestAt: Date | null; credentialsChangedAt: Date }): boolean {
  return a.lastConnectionTestResult === 'ok' && !!a.lastConnectionTestAt && a.lastConnectionTestAt.getTime() >= a.credentialsChangedAt.getTime();
}

export interface ArchiveFacts {
  liveAttempts: number;
  openRefunds: number;
  /** The newest succeeded payment or refund of the account. */
  lastMoneyAt: Date | null;
  now: Date;
  disputeWindowDays: number;
}

/** What stops a retired account from being archived (plan 0.1, 6.4; plan 4.1, 4.3); empty means it may be archived. */
export function archiveBlockers(f: ArchiveFacts): string[] {
  const out: string[] = [];
  if (f.liveAttempts > 0) out.push('live_payment_attempts');
  if (f.openRefunds > 0) out.push('refunds_in_progress');
  if (f.lastMoneyAt && f.lastMoneyAt.getTime() + f.disputeWindowDays * 86_400_000 > f.now.getTime()) out.push('within_dispute_window');
  return out;
}

/** Why the boot check pauses an active account (plan 4.1, 4.5), or null. */
export function bootPauseReason(manifest: AdapterManifest | undefined): 'boot_adapter_missing' | 'boot_adapter_planned' | null {
  if (!manifest) return 'boot_adapter_missing';
  if (manifest.status === 'planned') return 'boot_adapter_planned';
  return null;
}

/** The (method, country) pairs in `before` and not in `after` (plan 4.1, section 5). */
export function lostCoverage<T extends { method: string; country: string }>(before: readonly T[], after: readonly T[]): T[] {
  const kept = new Set(after.map((x) => `${x.method}|${x.country}`));
  return before.filter((x) => !kept.has(`${x.method}|${x.country}`));
}
