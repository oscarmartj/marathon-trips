import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { createEnrolledOwner } from '../src/platform/auth/demo-staff';
import { loadConfig } from '../src/platform/config/config';

/**
 * Creates a fresh enrolled owner for the end-to-end tests and prints { email, password, secret } as JSON (M10). Not an
 * HTTP route; refuses to run outside test and ci.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_ENV !== 'test' && config.APP_ENV !== 'ci') throw new Error('e2e-staff runs only with APP_ENV=test or ci');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  try {
    const email = `e2e-owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`;
    const owner = await createEnrolledOwner(prisma, config, email);
    process.stdout.write(JSON.stringify({ email: owner.email, password: owner.password, secret: owner.secret }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'e2e-staff failed');
  process.exit(1);
});
