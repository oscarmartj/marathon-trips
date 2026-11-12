import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { loadConfig } from '../src/platform/config/config';
import { seedDemoCatalogue } from '../prisma/seed/demo-catalogue';

/**
 * Makes sure the fictitious demo catalogue exists (the same seed as `pnpm db:seed`, which skips what is there) and prints
 * { packageId } of the Demo Harbour City Marathon weekend, a draft package with rooms, entries and extras but no prices, for
 * the pricing panel's end-to-end test. Not an HTTP route; refuses to run outside test and ci.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_ENV !== 'test' && config.APP_ENV !== 'ci') throw new Error('e2e-package runs only with APP_ENV=test or ci');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  try {
    await seedDemoCatalogue(prisma);
    const pkg = await prisma.package.findFirstOrThrow({ where: { edition: { race: { slug: 'demo-harbour-city-marathon' } } }, select: { id: true } });
    process.stdout.write(JSON.stringify({ packageId: pkg.id }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'e2e-package failed');
  process.exit(1);
});
