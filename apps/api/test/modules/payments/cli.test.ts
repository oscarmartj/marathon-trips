// The console command that creates a simulator account (plan 3.1, section 7).
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../src/cli';
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
