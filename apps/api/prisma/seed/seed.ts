import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { DEMO_OWNER_EMAIL, createEnrolledOwner, demoStaffAllowed } from '../../src/platform/auth/demo-staff';
import { AppConfig, loadConfig } from '../../src/platform/config/config';
import { PLATFORM_FLAGS } from '../../src/platform/flags/flag-registry';

/**
 * Idempotent demo seed. Refuses to run in production. Later tasks add their own named steps:
 * 0.3 demo flags and the demo owner, 0.5 the example table, 1.5 the catalogue.
 */
export async function seed(prisma: PrismaClient, appEnv: string, given?: AppConfig): Promise<void> {
  if (appEnv === 'production') throw new Error('db:seed refuses to run when APP_ENV=production');
  const config = given ?? loadConfig({ ...process.env, APP_ENV: appEnv });
  const steps: Array<{ name: string; run: () => Promise<void> }> = [];
  if (demoStaffAllowed(appEnv)) {
    // 0.3: platform flags at their demo value (customer sign-in on), never overwriting a value someone changed.
    steps.push({
      name: 'demo-flags',
      run: async () => {
        for (const f of PLATFORM_FLAGS) {
          await prisma.featureFlag.upsert({ where: { key: f.key }, create: { key: f.key, enabled: f.seedEnabled, description: f.description }, update: {} });
        }
      },
    });
    // 0.3: a demo owner with random credentials, printed once and only in development (M11). Running the seed again
    // does not recreate or print them; `pnpm api:cli staff:reset --email owner@example.test` issues a new set-up link.
    steps.push({
      name: 'demo-staff',
      run: async () => {
        if (await prisma.user.findUnique({ where: { kind_email: { kind: 'staff', email: DEMO_OWNER_EMAIL } } })) return;
        const owner = await createEnrolledOwner(prisma, config, DEMO_OWNER_EMAIL);
        if (appEnv === 'development') {
          console.log(['Demo owner (development only):', `  email:    ${owner.email}`, `  password: ${owner.password}`,
            `  TOTP:     ${owner.secret}`, `  otpauth:  ${owner.uri}`].join('\n'));
        }
      },
    });
  }
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
    await seed(prisma, config.APP_ENV, config);
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
