import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { emailSchema } from '@mt/shared';
import { AppModule } from './app.module';
import { OWNER_ROLE } from './platform/access/access.service';
import { SYSTEM_ACTOR, AuditService } from './platform/audit/audit.service';
import { StaffAuthService } from './platform/auth/staff-auth.service';
import { loadConfig } from './platform/config/config';
import { PrismaService } from './platform/database/prisma.service';

/**
 * Console commands for the people who run the server (plan 4.2): the first owner is created here, and an owner who lost
 * their phone and recovery codes is reset here. There is no recovery by email. Each prints a one-time set-up link.
 *
 *   pnpm api:cli staff:create --email someone@example.com [--owner]
 *   pnpm api:cli staff:reset --email someone@example.com
 */
export async function runCli(argv: string[], print: (line: string) => void = console.log): Promise<number> {
  const [command, ...rest] = argv;
  const flag = (name: string) => rest.includes(`--${name}`);
  const value = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command !== 'staff:create' && command !== 'staff:reset') {
    print('Usage: staff:create --email <address> [--owner] | staff:reset --email <address>');
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

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
