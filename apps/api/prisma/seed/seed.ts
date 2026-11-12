import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { DEMO_OWNER_EMAIL, createEnrolledOwner, demoStaffAllowed } from '../../src/platform/auth/demo-staff';
import { AppConfig, loadConfig } from '../../src/platform/config/config';
import { PLATFORM_FLAGS } from '../../src/platform/flags/flag-registry';
import { seedDemoCatalogue } from './demo-catalogue';

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
        // 6.1: business modules with a flag are on in demo data (a missing flag is off everywhere else).
        await prisma.featureFlag.upsert({ where: { key: 'module.suppliers' }, create: { key: 'module.suppliers', enabled: true, description: 'Suppliers, contracts, contracted allotments and supplier cost prices' }, update: {} });
        // 8.4: API keys and outgoing webhooks are on in demo data; off in production until switched on in the panel.
        await prisma.featureFlag.upsert({ where: { key: 'module.integrations' }, create: { key: 'module.integrations', enabled: true, description: 'API keys and outgoing webhooks: off = no key authenticates and no webhook is sent' }, update: {} });
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
  // 0.5: the example table's demo tasks and tags (the table of every shared capability).
  steps.push({
    name: 'demo-tasks',
    run: async () => {
      const tags = await Promise.all([['Follow up', '#b45309'], ['Travel', '#0369a1'], ['Admin', '#4d7c0f']].map(([name, colour]) => prisma.tag.upsert({ where: { name: name! }, create: { name: name!, colour: colour! }, update: {} })));
      const day = 86_400_000;
      const demo = [
        { title: 'Confirm hotel block for the sample marathon', status: 'open' as const, due: 7, tag: 1 },
        { title: 'Reply to the organiser about entry numbers', status: 'open' as const, due: 2, tag: 0 },
        { title: 'Update the airport transfer notes', status: 'open' as const, due: null, tag: 1 },
        { title: 'Review the draft terms of booking', status: 'done' as const, due: -3, tag: 2 },
        { title: 'Renew the domain name', status: 'cancelled' as const, due: null, tag: 2 },
        { title: 'Check last month\'s supplier invoices', status: 'open' as const, due: 14, tag: 2 },
      ];
      for (const d of demo) {
        const task = await prisma.task.create({ data: { title: d.title, status: d.status, dueAt: d.due === null ? null : new Date(Date.now() + d.due * day) } });
        await prisma.tagging.create({ data: { tagId: tags[d.tag]!.id, entityType: 'Task', entityId: task.id } });
        await prisma.searchDocument.create({ data: { entityType: 'Task', entityId: task.id, title: task.title, subtitle: task.status, permissionKey: 'common.task.read' } });
      }
    },
  });
  // 1.5: fictitious races, hotels and packages, all flagged demo (never publishable; see demo-catalogue.ts).
  steps.push({ name: 'demo-catalogue', run: () => seedDemoCatalogue(prisma) });
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
