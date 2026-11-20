import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { currentStep } from '../src/platform/auth/totp';
import { loadConfig } from '../src/platform/config/config';

/**
 * Makes the step-up of an end-to-end staff user stale (its sessions' second factor ten minutes old) and lets the current
 * authenticator code be used once more, so a spec can go through the step-up prompt (task 6.2). Not an HTTP route;
 * refuses to run outside test and ci. Usage: tsx scripts/e2e-stale-step-up.ts <email>
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_ENV !== 'test' && config.APP_ENV !== 'ci') throw new Error('e2e-stale-step-up runs only with APP_ENV=test or ci');
  const email = process.argv[2] ?? '';
  if (!/^e2e-owner-[a-z0-9-]+@example\.test$/.test(email)) throw new Error('e2e-stale-step-up only touches e2e owners');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { kind_email: { kind: 'staff', email } }, select: { id: true } });
    await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) } });
    await prisma.user.update({ where: { id: user.id }, data: { totpLastUsedStep: BigInt(currentStep() - 2) } });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'e2e-stale-step-up failed');
  process.exit(1);
});
