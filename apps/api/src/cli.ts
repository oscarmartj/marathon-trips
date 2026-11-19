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
import { STRIPE_TEST_KEY, STRIPE_WEBHOOK_SECRET } from './modules/payments/core/accounts.service';
import { AppError } from './platform/errors/safe-error';

/**
 * Console commands for the people who run the server (plan 4.2): the first owner is created here, and an owner who lost
 * their phone and recovery codes is reset here. There is no recovery by email. Each prints a one-time set-up link.
 *
 *   pnpm api:cli staff:create --email someone@example.com [--owner]
 *   pnpm api:cli staff:reset --email someone@example.com
 *   pnpm api:cli maintenance:on | maintenance:off | maintenance:status
 *   pnpm api:cli payments:simulator-account [--name <display name>]
 *   STRIPE_TEST_SECRET_KEY=… STRIPE_TEST_WEBHOOK_SECRET=… pnpm api:cli payments:stripe-test-account [--name <display name>]
 *   pnpm api:cli privacy:erasures-list > erasures.json
 *   pnpm api:cli privacy:erasures-reapply erasures.json
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
  if (command === 'payments:stripe-test-account') return runStripeTestAccount(value('name'), print);
  if (command === 'privacy:erasures-list') return runErasuresList(print);
  if (command === 'privacy:erasures-reapply') return runErasuresReapply(rest[0], print);
  if (command !== 'staff:create' && command !== 'staff:reset') {
    print('Usage: staff:create --email <address> [--owner] | staff:reset --email <address> | maintenance:on|off|status | payments:simulator-account [--name <name>] | payments:stripe-test-account [--name <name>] | privacy:erasures-list | privacy:erasures-reapply <file>');
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

/**
 * A Stripe account in test mode (task 3.3). The keys come only from STRIPE_TEST_SECRET_KEY and STRIPE_TEST_WEBHOOK_SECRET
 * (an argument would stay in the shell history); a live key is refused before anything else; never in production.
 */
export async function runStripeTestAccount(name: string | undefined, print: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const appEnv = appEnvSchema.safeParse(env.APP_ENV);
  if (!appEnv.success || appEnv.data === 'production') {
    print('Stripe test accounts are not created in production');
    return 1;
  }
  const secretKey = env.STRIPE_TEST_SECRET_KEY ?? '';
  const webhookSecret = env.STRIPE_TEST_WEBHOOK_SECRET ?? '';
  // The values are never printed, not even in an error.
  if (!STRIPE_TEST_KEY.test(secretKey)) {
    print('STRIPE_TEST_SECRET_KEY must hold a Stripe test-mode key (sk_test_… or rk_test_…)');
    return 2;
  }
  if (!STRIPE_WEBHOOK_SECRET.test(webhookSecret)) {
    print('STRIPE_TEST_WEBHOOK_SECRET must hold the endpoint signing secret (whsec_…)');
    return 2;
  }
  process.env.JOBS_WORKERS = 'off';
  loadConfig();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const created = await app.get(ProviderAccountsService).createStripeTestAccount({ displayName: name, secretKey, webhookSecret });
    print(`Stripe account ${created.id} created (test mode, adapter experimental). Its webhook URL, shown once:`);
    print(created.webhookUrl);
    return 0;
  } catch (e) {
    print(e instanceof AppError ? e.message : 'Failed');
    return 1;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}

/**
 * Task 5.5 (plan docs/plans/5.5-privacy-export-erase.md, section 2.11): restoring an older backup brings back customers
 * erased since. Before a restore, list the completed erasures of the live database (ids only, no personal data); after
 * it, apply them again. A customer whose restored data has an open trip is listed, not erased: a person decides.
 */
async function runErasuresList(print: (line: string) => void): Promise<number> {
  process.env.JOBS_WORKERS = 'off';
  loadConfig();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const { ErasureService } = await import('./modules/privacy');
    const rows = await app.get(ErasureService).erasedIds();
    print(JSON.stringify(rows.map((r) => ({ customerId: r.customerId, userId: r.userId, completedAt: r.completedAt?.toISOString() ?? null }))));
    return 0;
  } catch (e) {
    print(e instanceof Error ? e.message : 'Failed');
    return 1;
  } finally {
    await app.close();
  }
}

async function runErasuresReapply(file: string | undefined, print: (line: string) => void): Promise<number> {
  if (!file) {
    print('Usage: privacy:erasures-reapply <file from privacy:erasures-list>');
    return 2;
  }
  const { readFileSync } = await import('node:fs');
  let list: Array<{ customerId: string | null; userId: string | null }>;
  try {
    list = JSON.parse(readFileSync(file, 'utf8')) as typeof list;
    if (!Array.isArray(list)) throw new Error('not a list');
  } catch {
    print('The file is not a list from privacy:erasures-list');
    return 2;
  }
  process.env.JOBS_WORKERS = 'off';
  loadConfig();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  let failed = 0;
  try {
    const { ErasureService } = await import('./modules/privacy');
    const erasure = app.get(ErasureService);
    const prisma = app.get(PrismaService);
    for (const row of list) {
      try {
        if (row.customerId) {
          if (!(await prisma.customer.findUnique({ where: { id: row.customerId }, select: { id: true } }))) continue; // not in this backup
          const r = await erasure.erase(row.customerId, SYSTEM_ACTOR);
          print(`${row.customerId}: ${r.alreadyErased ? 'already erased' : 'erased again'}`);
        } else if (row.userId) {
          if (!(await prisma.user.findUnique({ where: { id: row.userId }, select: { id: true } }))) continue;
          await erasure.eraseAccount(row.userId, SYSTEM_ACTOR);
          print(`${row.userId}: account erased again`);
        }
      } catch (e) {
        failed++;
        print(`${row.customerId ?? row.userId}: NOT erased (${e instanceof Error ? (e as { code?: string }).code ?? e.message : 'failed'}); decide by hand`);
      }
    }
    return failed > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}
