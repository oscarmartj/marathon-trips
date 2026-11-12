import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { newToken, tokenHash } from '../src/platform/auth/tokens';
import { loadConfig } from '../src/platform/config/config';

/**
 * Makes a sign-in link token for a fresh customer address and prints { email, token } as JSON, so an end-to-end test can
 * sign a customer in without reading a mailbox. Turns the customer sign-in flag on, as the demo seed does. Not an HTTP
 * route; refuses to run outside test and ci. The address ends in example.test, which no mail is ever sent to.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_ENV !== 'test' && config.APP_ENV !== 'ci') throw new Error('e2e-customer runs only with APP_ENV=test or ci');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  try {
    await prisma.featureFlag.upsert({ where: { key: 'auth.customer_sign_in' }, update: { enabled: true }, create: { key: 'auth.customer_sign_in', enabled: true, description: 'Customers can ask for a sign-in link and sign in' } });
    const email = `e2e-customer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`;
    const token = newToken();
    await prisma.loginToken.create({ data: { purpose: 'magic_link', email, userId: null, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 15 * 60_000) } });
    process.stdout.write(JSON.stringify({ email, token }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'e2e-customer failed');
  process.exit(1);
});
