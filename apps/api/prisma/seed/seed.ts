import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { loadConfig } from '../../src/platform/config/config';

/**
 * Idempotent demo seed. Refuses to run in production. Later tasks add their own named steps:
 * 0.3 demo staff, 0.5 the example table, 1.5 the catalogue.
 */
export async function seed(prisma: PrismaClient, appEnv: string): Promise<void> {
  if (appEnv === 'production') throw new Error('db:seed refuses to run when APP_ENV=production');
  const steps: Array<{ name: string; run: () => Promise<void> }> = [];
  for (const step of steps) {
    const done = await prisma.seedRun.findUnique({ where: { name: step.name } });
    if (done) continue;
    await step.run();
    await prisma.seedRun.create({ data: { name: step.name } });
  }
  await prisma.seedRun.upsert({ where: { name: 'base' }, create: { name: 'base' }, update: {} });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  try {
    await seed(prisma, config.APP_ENV);
    console.log('Seed complete');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'Seed failed');
    process.exit(1);
  });
}
