// Pure rules of gateway accounts in the panel (task 4.1, plan docs/plans/4.1-provider-accounts-panel.md, section 7),
// table-driven: what may be created where, status pairs (also against migration 0034's trigger), typed credentials,
// archive blockers, coverage loss, the boot check and the connection test's closed list of codes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENVS } from '@mt/shared';
import type { AppEnv } from '@mt/shared';
import {
  PROVIDER_ACCOUNT_STATUS_PAIRS, UNKNOWN_FIELD, allowedTransitions, archiveBlockers, bootPauseReason, checkCredentials, connectionTestCurrent, creationBlockReason,
  lostCoverage, secretsChangeAcceptable, transitionAllowed, webhookSecretValid,
} from '../../../src/modules/payments/core/account-rules';
import type { AccountStatus } from '../../../src/modules/payments/core/account-rules';
import { CONNECTION_TEST_CODES, normaliseTestCode } from '../../../src/modules/payments/core/gateway';
import { accountSetupProblems, manifestProblems } from '../../../src/modules/payments/core/registry';
import type { AdapterManifest } from '../../../src/modules/payments/core/provider';
import { simulatorManifest } from '../../../src/modules/payments/adapters/simulator/simulator';
import { stripeManifest } from '../../../src/modules/payments/adapters/stripe/stripe';
import { ManualProvider } from '../../../src/modules/payments/adapters/manual/manual';
import { ProviderAccountRateLimitGuard } from '../../../src/modules/payments/rate-limit.guard';

const sim = simulatorManifest('http://localhost:3000');
const stripe = stripeManifest();
const manual = new ManualProvider().manifest;
const verified: AdapterManifest = { ...stripe, key: 'real', status: 'verified', evidence: 'docs/done/x.md' };
const planned: AdapterManifest = { ...stripe, key: 'later', status: 'planned' };
const STATUSES: AccountStatus[] = ['active', 'paused', 'retired', 'archived'];

describe('account_creation_policy_matrix (plan 4.1, 4.1 step 1)', () => {
  const expected = (env: AppEnv, mode: string, m: AdapterManifest | undefined): string | null => {
    if (mode !== 'test') return 'live_mode_not_available';
    if (!m) return 'adapter_unknown';
    if (m.status === 'planned') return 'adapter_unavailable';
    if (env === 'production') return 'account_mode_not_for_environment';
    if (m.testOnly && !['development', 'test', 'ci'].includes(env)) return 'test_adapter_blocked_in_environment';
    return null;
  };
  it('every environment × mode × adapter', () => {
    expect(APP_ENVS.length).toBe(5);
    const wrong: string[] = [];
    for (const env of APP_ENVS) for (const mode of ['test', 'live', 'other']) for (const m of [sim, stripe, manual, verified, planned, undefined]) {
      const got = creationBlockReason(m, mode, env);
      const want = expected(env, mode, m);
      if (got !== want) wrong.push(`${env}/${mode}/${m?.key ?? 'none'}: ${got} ≠ ${want}`);
    }
    expect(wrong).toEqual([]);
  });
  it('live_account_creation_rejected_for_unverified_adapter and live_account_creation_rejected_while_check_in_place: live is refused first, even for a verified adapter in production', () => {
    for (const env of APP_ENVS) for (const m of [sim, stripe, manual, verified]) expect(creationBlockReason(m, 'live', env)).toBe('live_mode_not_available');
  });
});

describe('account_status_transition_matrix (plan 0.1, 6.4)', () => {
  it('every pair, and the same list as migration 0034 trigger', () => {
    const allowed = new Set(PROVIDER_ACCOUNT_STATUS_PAIRS.map(([a, b]) => `${a}>${b}`));
    expect([...allowed].sort()).toEqual(['active>paused', 'active>retired', 'paused>active', 'paused>retired', 'retired>archived']);
    for (const from of STATUSES) for (const to of STATUSES) expect(transitionAllowed(from, to)).toBe(allowed.has(`${from}>${to}`));
    expect(allowedTransitions('archived')).toEqual([]);
    expect(allowedTransitions('retired')).toEqual(['archived']);
    const sql = readFileSync(join(__dirname, '../../../prisma/migrations/0034_provider_accounts_admin/migration.sql'), 'utf8');
    const list = /NOT IN\s*\(([^)]*)\)/.exec(sql)![1]!;
    expect([...list.matchAll(/'([a-z]+>[a-z]+)'/g)].map((m) => m[1]).sort()).toEqual([...allowed].sort());
  });
});

describe('credential_fields_validation_table (plan 4.1, section 2 and 15.6)', () => {
  const key = `sk_test_${'a'.repeat(24)}`;
  const cases: Array<[string, unknown, boolean, { ok: true } | { fields: string[] }]> = [
    ['valid full', { secretKey: key }, false, { ok: true }],
    ['missing field', {}, false, { fields: ['secretKey'] }],
    ['live key in a test account', { secretKey: `sk_live_${'a'.repeat(24)}` }, false, { fields: ['secretKey'] }],
    ['publishable key', { secretKey: `pk_test_${'a'.repeat(24)}` }, false, { fields: ['secretKey'] }],
    ['too long', { secretKey: `sk_test_${'a'.repeat(600)}` }, false, { fields: ['secretKey'] }],
    ['control character', { secretKey: `${key}\n` }, false, { fields: ['secretKey'] }],
    ['not a string', { secretKey: 42 }, false, { fields: ['secretKey'] }],
    ['unknown key is never named', { secretKey: key, [`sk_live_${'z'.repeat(20)}`]: 'x' }, false, { fields: [UNKNOWN_FIELD] }],
    ['not an object', [key], false, { fields: ['credentials'] }],
    ['partial: nothing sent', {}, true, { fields: ['credentials'] }],
    ['partial: one field', { secretKey: key }, true, { ok: true }],
  ];
  it.each(cases)('%s', (_name, input, partial, want) => {
    const r = checkCredentials(stripe.account, input, { partial });
    if ('ok' in want) expect(r.ok).toBe(true);
    else {
      expect(r).toEqual({ ok: false, fields: want.fields });
      expect(JSON.stringify(r)).not.toContain('zzzz');
    }
  });
  it('webhook secrets: Stripe takes a whsec_; the simulator and the manual adapter make their own', () => {
    expect(webhookSecretValid(stripe.account, `whsec_${'a'.repeat(30)}`)).toBe(true);
    for (const bad of ['', 'whsec_', `sk_test_${'a'.repeat(20)}`, `whsec_${'a'.repeat(30)}\r`, null, 7]) expect(webhookSecretValid(stripe.account, bad)).toBe(false);
    expect(webhookSecretValid(sim.account, `whsec_${'a'.repeat(30)}`)).toBe(false);
    expect(webhookSecretValid(manual.account, `whsec_${'a'.repeat(30)}`)).toBe(false);
  });
});

describe('manifest_account_descriptor_problems', () => {
  it('the real adapters are clean and test-mode only (no live pattern exists)', () => {
    expect(manifestProblems([sim, stripe, manual])).toEqual([]);
    for (const m of [sim, stripe, manual]) for (const f of m.account.fields) expect(new RegExp(f.pattern).test(`sk_live_${'a'.repeat(24)}`)).toBe(false);
  });
  it('duplicate keys, unanchored or broken patterns, odd names and prefixes are reported', () => {
    const bad = (account: AdapterManifest['account']) => accountSetupProblems({ ...stripe, account });
    expect(bad({ fields: [{ key: 'a1', label: 'x', pattern: '^x$' }, { key: 'a1', label: 'y', pattern: '^y$' }], webhookSecret: { source: 'generated' } })).toEqual([expect.stringContaining('duplicate')]);
    expect(bad({ fields: [{ key: 'key', label: 'x', pattern: 'x' }], webhookSecret: { source: 'generated' } })).toEqual([expect.stringContaining('anchored')]);
    expect(bad({ fields: [{ key: 'key', label: 'x', pattern: '^(x$' }], webhookSecret: { source: 'generated' } })).toEqual([expect.stringContaining('anchored')]);
    expect(bad({ fields: [{ key: 'Bad-Key', label: 'x', pattern: '^x$' }], webhookSecret: { source: 'generated' } })).toEqual([expect.stringContaining('plain name')]);
    expect(bad({ fields: [], generated: [{ key: 'apiKey', prefix: 'Bad Prefix' }], webhookSecret: { source: 'generated' } })).toEqual([expect.stringContaining('prefix')]);
    expect(bad({ fields: [], webhookSecret: { source: 'entered', label: 'x', pattern: 'whsec' } })).toEqual([expect.stringContaining('webhook secret')]);
  });
});

describe('secrets changes, tests and archive', () => {
  it('secrets_change_acceptable_table: ok, or a missing webhook secret the change does not set (no deadlock fixing a key first)', () => {
    const rows: Array<[string, boolean, boolean, boolean]> = [
      ['ok', false, false, true], ['ok', true, true, true],
      ['webhook_secret_missing', false, false, true], ['webhook_secret_missing', true, false, false], ['webhook_secret_missing', false, true, false],
      ['provider_auth_failed', false, false, false], ['provider_timeout', false, false, false], ['credentials_unreadable', false, false, false],
    ];
    for (const [result, sets, has, want] of rows) expect(secretsChangeAcceptable(result, { setsWebhookSecret: sets, hasWebhookSecret: has })).toBe(want);
  });
  it('connection_test_current: ok and not older than the credentials', () => {
    const at = new Date('2026-11-19T00:00:00Z');
    const later = new Date(at.getTime() + 1);
    expect(connectionTestCurrent({ lastConnectionTestResult: 'ok', lastConnectionTestAt: at, credentialsChangedAt: at })).toBe(true);
    expect(connectionTestCurrent({ lastConnectionTestResult: 'ok', lastConnectionTestAt: at, credentialsChangedAt: later })).toBe(false);
    expect(connectionTestCurrent({ lastConnectionTestResult: 'provider_auth_failed', lastConnectionTestAt: later, credentialsChangedAt: at })).toBe(false);
    expect(connectionTestCurrent({ lastConnectionTestResult: null, lastConnectionTestAt: null, credentialsChangedAt: at })).toBe(false);
  });
  it('archive_blockers_table', () => {
    const now = new Date('2026-11-19T00:00:00Z');
    const day = 86_400_000;
    const base = { liveAttempts: 0, openRefunds: 0, lastMoneyAt: null as Date | null, now, disputeWindowDays: 180 };
    expect(archiveBlockers(base)).toEqual([]);
    expect(archiveBlockers({ ...base, liveAttempts: 1 })).toEqual(['live_payment_attempts']);
    expect(archiveBlockers({ ...base, openRefunds: 2 })).toEqual(['refunds_in_progress']);
    expect(archiveBlockers({ ...base, lastMoneyAt: new Date(now.getTime() - 179 * day) })).toEqual(['within_dispute_window']);
    expect(archiveBlockers({ ...base, lastMoneyAt: new Date(now.getTime() - 180 * day) })).toEqual([]);
    expect(archiveBlockers({ ...base, lastMoneyAt: new Date(now.getTime() - 180 * day + 1) })).toEqual(['within_dispute_window']);
    expect(archiveBlockers({ liveAttempts: 1, openRefunds: 1, lastMoneyAt: now, now, disputeWindowDays: 60 })).toEqual(['live_payment_attempts', 'refunds_in_progress', 'within_dispute_window']);
  });
  it('coverage_loss_table', () => {
    const c = (method: string, country: string) => ({ method, country });
    expect(lostCoverage([c('card', 'AU')], [])).toEqual([c('card', 'AU')]);
    expect(lostCoverage([c('card', 'AU'), c('payid_transfer', 'AU')], [c('card', 'AU')])).toEqual([c('payid_transfer', 'AU')]);
    expect(lostCoverage([c('card', 'AU'), c('card', 'NZ')], [c('card', 'NZ'), c('card', 'AU')])).toEqual([]);
    expect(lostCoverage([], [c('card', 'AU')])).toEqual([]);
  });
  it('boot_pause_reason: missing or planned adapters only', () => {
    expect(bootPauseReason(undefined)).toBe('boot_adapter_missing');
    expect(bootPauseReason(planned)).toBe('boot_adapter_planned');
    for (const m of [sim, stripe, manual, verified]) expect(bootPauseReason(m)).toBeNull();
  });
  it('connection test codes are a closed list; anything else becomes provider_rejected', () => {
    for (const code of CONNECTION_TEST_CODES) expect(normaliseTestCode(code)).toBe(code);
    for (const free of ['Invalid API Key provided: sk_test_123', 'oops', '']) expect(normaliseTestCode(free)).toBe('provider_rejected');
  });
  it('provider_account_routes_rate_limited per staff user', () => {
    const guard = new ProviderAccountRateLimitGuard();
    const ctx = (userId: string) => ({ switchToHttp: () => ({ getRequest: () => ({ auth: { userId } }) }) }) as never;
    for (let i = 0; i < 60; i++) expect(guard.canActivate(ctx('u1'))).toBe(true);
    expect(() => guard.canActivate(ctx('u1'))).toThrow();
    expect(guard.canActivate(ctx('u2'))).toBe(true);
  });
});
