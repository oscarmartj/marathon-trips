// The console command that creates a simulator account (plan 3.1, section 7).
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { runCli, runStripeTestAccount } from '../../../src/cli';
import { PrismaService } from '../../../src/platform/database/prisma.service';
import { makeApp } from '../../support/auth';

vi.setConfig({ testTimeout: 60_000 });

describe('payments:simulator-account', () => {
  it('simulator_account_cli_refuses_production (and staging)', async () => {
    const saved = process.env.APP_ENV;
    try {
      for (const env of ['production', 'staging']) {
        process.env.APP_ENV = env;
        const lines: string[] = [];
        expect(await runCli(['payments:simulator-account'], (l) => lines.push(l))).toBe(1);
        expect(lines).toEqual(['The payment simulator exists only in development, test and ci']);
      }
    } finally {
      process.env.APP_ENV = saved;
    }
  });

  it('creates a test-mode simulator account and prints its webhook URL once, never a secret', async () => {
    const lines: string[] = [];
    expect(await runCli(['payments:simulator-account', '--name', 'CLI simulator'], (l) => lines.push(l))).toBe(0);
    const id = /account ([0-9a-f-]{36})/.exec(lines[0]!)![1]!;
    expect(lines[1]).toMatch(/\/payments\/webhooks\/[A-Za-z0-9_-]{43}$/);
    const t = await makeApp();
    try {
      const a = await t.app.get(PrismaService).providerAccount.findUniqueOrThrow({ where: { id } });
      expect([a.adapterKey, a.mode, a.status, a.displayName]).toEqual(['simulator', 'test', 'active', 'CLI simulator']);
      expect(lines.join('\n')).not.toContain(a.credentialsCiphertext);
      expect(lines.join('\n')).not.toMatch(/sim_test_/);
      await t.prisma.providerAccount.update({ where: { id }, data: { status: 'paused' } });
      expect(await t.prisma.auditLog.count({ where: { action: 'payments.providerAccount.created', entityId: id } })).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe('payments:stripe-test-account (task 3.3)', () => {
  const testKey = () => `sk_${'test'}_${randomBytes(16).toString('hex')}`;
  const hook = () => `whsec_${randomBytes(16).toString('hex')}`;
  it('stripe_test_account_refuses_live_keys_and_reads_env_only', async () => {
    const cases: Array<[Record<string, string>, number, RegExp]> = [
      [{ APP_ENV: 'production', STRIPE_TEST_SECRET_KEY: testKey(), STRIPE_TEST_WEBHOOK_SECRET: hook() }, 1, /not created in production/],
      [{ APP_ENV: 'test', STRIPE_TEST_SECRET_KEY: `sk_${'live'}_${randomBytes(16).toString('hex')}`, STRIPE_TEST_WEBHOOK_SECRET: hook() }, 2, /test-mode key/],
      [{ APP_ENV: 'test', STRIPE_TEST_SECRET_KEY: `rk_${'live'}_${randomBytes(16).toString('hex')}`, STRIPE_TEST_WEBHOOK_SECRET: hook() }, 2, /test-mode key/],
      [{ APP_ENV: 'test', STRIPE_TEST_WEBHOOK_SECRET: hook() }, 2, /test-mode key/],
      [{ APP_ENV: 'test', STRIPE_TEST_SECRET_KEY: testKey(), STRIPE_TEST_WEBHOOK_SECRET: 'nope' }, 2, /signing secret/],
    ];
    for (const [env, code, message] of cases) {
      const lines: string[] = [];
      expect(await runStripeTestAccount('x', (l) => lines.push(l), env)).toBe(code);
      expect(lines.join('\n')).toMatch(message);
      // The values are never printed.
      for (const v of Object.values(env).filter((v) => v.length > 12)) expect(lines.join('\n')).not.toContain(v);
    }
  });

  it('creates a test-mode Stripe account from the environment and prints the webhook URL once', async () => {
    const key = testKey();
    const lines: string[] = [];
    expect(await runStripeTestAccount('CLI Stripe', (l) => lines.push(l), { APP_ENV: 'test', STRIPE_TEST_SECRET_KEY: key, STRIPE_TEST_WEBHOOK_SECRET: hook() })).toBe(0);
    const id = /account ([0-9a-f-]{36})/.exec(lines[0]!)![1]!;
    expect(lines[1]).toMatch(/\/payments\/webhooks\/[A-Za-z0-9_-]{43}$/);
    expect(lines.join('\n')).not.toContain(key);
    const t = await makeApp();
    try {
      const a = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } });
      expect([a.adapterKey, a.mode, a.displayName]).toEqual(['stripe', 'test', 'CLI Stripe']);
      expect(a.credentialsCiphertext).not.toContain(key);
      await t.prisma.providerAccount.update({ where: { id }, data: { status: 'paused' } });
    } finally {
      await t.close();
    }
  });
});

describe('no_stripe_keys_in_repository (phase 3: sandbox keys live in environment variables)', () => {
  it('no Stripe secret, restricted or webhook key is committed', () => {
    const root = join(__dirname, '../../../../..');
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
    const pattern = new RegExp(`\\b(?:(?:sk|rk|pk)_(?:test|live)_|whsec_)[A-Za-z0-9]{16,}`);
    // The public example secret of the Standard Webhooks specification (task 8.4's signing test vector), not a key.
    const PUBLIC_EXAMPLES = ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'];
    const hits: string[] = [];
    for (const f of files) {
      if (/\.(png|jpe?g|webp|ico|woff2?|pdf|lock)$/.test(f) || f.includes('pnpm-lock')) continue;
      let text: string;
      try {
        text = execFileSync('git', ['show', `:${f}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
      } catch {
        continue;
      }
      for (const e of PUBLIC_EXAMPLES) text = text.split(e).join('');
      if (pattern.test(text)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
