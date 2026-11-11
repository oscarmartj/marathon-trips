import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client';
import { runCli } from '../../src/cli';
import { createEnrolledOwner, demoStaffAllowed } from '../../src/platform/auth/demo-staff';
import { testConfig } from '../support/platform';
import { uniqueEmail } from '../support/auth';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
afterAll(async () => prisma.$disconnect());

describe('demo staff and console commands', () => {
  it('seed_demo_staff_never_outside_dev_test_ci', async () => {
    expect(['development', 'test', 'ci'].map(demoStaffAllowed)).toEqual([true, true, true]);
    expect(['staging', 'production'].map(demoStaffAllowed)).toEqual([false, false]);
    const staging = { ...testConfig(), APP_ENV: 'staging' as const };
    await expect(createEnrolledOwner(prisma, staging, uniqueEmail())).rejects.toThrow(/only in development, test and ci/);
  });

  it('the seed creates the demo owner once and prints credentials only in development', async () => {
    const { seed } = await import('../../prisma/seed/seed');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await seed(prisma, 'test', testConfig());
      await seed(prisma, 'test', testConfig());
      expect(await prisma.user.count({ where: { kind: 'staff', email: 'owner@example.test' } })).toBe(1);
      expect(log.mock.calls.flat().join('\n')).not.toMatch(/password|TOTP/);
    } finally {
      log.mockRestore();
    }
  });

  it('staff:create prints a single-use set-up link; staff:reset revokes and prints a new one', async () => {
    const email = uniqueEmail('cli');
    const lines: string[] = [];
    expect(await runCli(['staff:create', '--email', email, '--owner'], (l) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toMatch(/\/admin\/enrol#token=[A-Za-z0-9_-]{43}/);
    const user = await prisma.user.findUniqueOrThrow({ where: { kind_email: { kind: 'staff', email } }, include: { roles: { include: { role: true } } } });
    expect(user.roles.map((r) => r.role.key)).toEqual(['owner']);
    expect(await runCli(['staff:create', '--email', email], (l) => lines.push(l))).toBe(1);
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 7, nextLoginAllowedAt: new Date(Date.now() + 60_000) } });
    const out: string[] = [];
    expect(await runCli(['staff:reset', '--email', email], (l) => out.push(l))).toBe(0);
    expect(out.join('\n')).toMatch(/#token=/);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({ failedLoginCount: 0, nextLoginAllowedAt: null, passwordHash: null, totpEnabledAt: null });
    expect(await prisma.loginToken.count({ where: { userId: user.id, purpose: 'staff_enrolment', consumedAt: null } })).toBe(1);
    expect(await runCli(['nonsense'], () => undefined)).toBe(2);
  });
});
