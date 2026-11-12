import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { createEnrolledOwner } from '../src/platform/auth/demo-staff';
import { loadConfig } from '../src/platform/config/config';

/**
 * Creates a fresh enrolled owner for the end-to-end tests and prints { email, password, secret } as JSON (M10). Not an
 * HTTP route; refuses to run outside test and ci. With `--permissions a,b` the user is not an owner but holds a role of
 * its own with just those permissions, for specs that check what a limited user cannot do.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_ENV !== 'test' && config.APP_ENV !== 'ci') throw new Error('e2e-staff runs only with APP_ENV=test or ci');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  try {
    const email = `e2e-owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`;
    const owner = await createEnrolledOwner(prisma, config, email);
    const flag = process.argv.indexOf('--permissions');
    if (flag > -1) {
      const permissions = (process.argv[flag + 1] ?? '').split(',').filter(Boolean);
      const key = `e2e${owner.id.replace(/-/g, '').slice(-12)}`;
      const role = await prisma.role.create({ data: { key, name: `E2E ${key}` } });
      await prisma.rolePermission.createMany({ data: permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })) });
      await prisma.userRole.deleteMany({ where: { userId: owner.id } });
      await prisma.userRole.create({ data: { userId: owner.id, roleId: role.id } });
    }
    process.stdout.write(JSON.stringify({ email: owner.email, password: owner.password, secret: owner.secret }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'e2e-staff failed');
  process.exit(1);
});
