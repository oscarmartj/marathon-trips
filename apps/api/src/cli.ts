import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { appEnvSchema, emailSchema } from '@mt/shared';
import { AppModule } from './app.module';
import { OWNER_ROLE } from './platform/access/access.service';
import { SYSTEM_ACTOR, AuditService } from './platform/audit/audit.service';
import { StaffAuthService } from './platform/auth/staff-auth.service';
import { loadConfig } from './platform/config/config';
import { PrismaService } from './platform/database/prisma.service';
import { FLAGS } from './platform/flags/flag-registry';
import { FlagsAdminService } from './platform/flags/flags-admin.service';
import { FeatureFlagService } from './platform/flags/flags.service';
import { ProviderAccountsService } from './modules/payments';
import { TEST_ADAPTER_ENVS } from './modules/payments/core/gateway';

/**
 * Console commands for the people who run the server (plan 4.2): the first owner is created here, and an owner who lost
 * their phone and recovery codes is reset here. There is no recovery by email. Each prints a one-time set-up link.
 *
 *   pnpm api:cli staff:create --email someone@example.com [--owner]
 *   pnpm api:cli staff:reset --email someone@example.com
 *   pnpm api:cli maintenance:on | maintenance:off | maintenance:status
 *   pnpm api:cli payments:simulator-account [--name <display name>]
 *
 * The maintenance commands exist for the moment nobody can sign in to the panel (task 8.6); they are audited as "system".
 */
export async function runCli(argv: string[], print: (line: string) => void = console.log): Promise<number> {
  const [command, ...rest] = argv;
  const flag = (name: string) => rest.includes(`--${name}`);
  const value = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command === 'maintenance:on' || command === 'maintenance:off' || command === 'maintenance:status') return runMaintenance(command, print);
  if (command === 'payments:simulator-account') return runSimulatorAccount(value('name'), print);
  if (command !== 'staff:create' && command !== 'staff:reset') {
    print('Usage: staff:create --email <address> [--owner] | staff:reset --email <address> | maintenance:on|off|status | payments:simulator-account [--name <name>]');
    return 2;
  }
  const email = emailSchema.safeParse(value('email'));
  if (!email.success) {
    print('A valid --email is required');
    return 2;
  }
  process.env.JOBS_WORKERS = 'off';
  loadConfig();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const prisma = app.get(PrismaService);
    const staff = app.get(StaffAuthService);
    const audit = app.get(AuditService);
    const link = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { kind_email: { kind: 'staff', email: email.data } }, select: { id: true } });
      if (command === 'staff:reset') {
        if (!existing) throw new Error('No staff account with that email');
        return staff.resetCredentials(tx, existing.id, SYSTEM_ACTOR, null);
      }
      if (existing) throw new Error('A staff account with that email already exists; use staff:reset');
      const user = await tx.user.create({ data: { kind: 'staff', email: email.data }, select: { id: true, kind: true, status: true } });
      const roleKeys: string[] = [];
      if (flag('owner')) {
        const role = await tx.role.findUniqueOrThrow({ where: { key: OWNER_ROLE } });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
        roleKeys.push(OWNER_ROLE);
      }
      await audit.record(tx, {
        actor: SYSTEM_ACTOR, action: 'access.user.created', entityType: 'User', entityId: user.id, fieldClasses: { roleKeys: 'nopii' },
        after: { kind: user.kind, status: user.status, email: email.data, roleKeys },
      });
      return staff.issueEnrolment(tx, user.id, email.data);
    });
    print(`Set-up link (single use, expires ${link.expiresAt.toISOString()}). Send it to the person over a channel you trust:`);
    print(link.url);
    return 0;
  } catch (e) {
    print(e instanceof Error ? e.message : 'Failed');
    return 1;
  } finally {
    await app.close();
  }
}

async function runMaintenance(command: 'maintenance:on' | 'maintenance:off' | 'maintenance:status', print: (line: string) => void): Promise<number> {
  process.env.JOBS_WORKERS = 'off';
  loadConfig();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const flags = app.get(FeatureFlagService);
    if (command !== 'maintenance:status') {
      await app.get(FlagsAdminService).setFlag(SYSTEM_ACTOR, FLAGS.maintenance, command === 'maintenance:on', 'Set from the command line');
    }
    print(`Maintenance mode is ${(await flags.isEnabled(FLAGS.maintenance)) ? 'ON' : 'off'}`);
    return 0;
  } catch (e) {
    print(e instanceof Error ? e.message : 'Failed');
    return 1;
  } finally {
    await app.close();
  }
}

/**
 * Task 3.1: a test-mode account with the payment simulator, the only way to create a payment account until the panel
 * (4.1). Refused outside development, test and ci. The webhook URL carries a secret token and is printed once.
 */
async function runSimulatorAccount(name: string | undefined, print: (line: string) => void): Promise<number> {
  process.env.JOBS_WORKERS = 'off';
  // Checked before anything else, even before the configuration is loaded.
  const env = appEnvSchema.safeParse(process.env.APP_ENV);
  if (!env.success || !TEST_ADAPTER_ENVS.includes(env.data)) {
    print('The payment simulator exists only in development, test and ci');
    return 1;
  }
  loadConfig();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const created = await app.get(ProviderAccountsService).createSimulatorAccount({ displayName: name });
    print(`Simulator account ${created.id} created (test mode). Its webhook URL, shown once:`);
    print(created.webhookUrl);
    return 0;
  } catch (e) {
    print(e instanceof Error ? e.message : 'Failed');
    return 1;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
