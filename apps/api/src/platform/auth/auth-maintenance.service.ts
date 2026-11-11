import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { QUEUES } from '../jobs/queues';

const DAY = 24 * 3600_000;

/**
 * Daily retention (decision 12 of the 0.3 plan): expired sign-in tokens, finished customer sessions, staff sessions 90
 * days after they ended (AuditLog.sessionId points at them), auth emails after 30 days, and the audit purge function.
 */
@Injectable()
export class AuthMaintenanceService implements OnApplicationBootstrap {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.authMaintenance, async () => void (await this.run()));
    await this.jobs.schedule(QUEUES.authMaintenance, '17 3 * * *');
  }

  async run(now: Date = new Date()): Promise<{ tokens: number; customerSessions: number; staffSessions: number; emails: number; auditValues: number }> {
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const tokens = await this.prisma.loginToken.deleteMany({ where: { expiresAt: { lt: ago(DAY) } } });
    const customerSessions = await this.prisma.session.deleteMany({
      where: { kind: 'customer', OR: [{ expiresAt: { lt: now } }, { idleExpiresAt: { lt: now } }, { revokedAt: { lt: now } }] },
    });
    const staffSessions = await this.prisma.session.deleteMany({
      where: { kind: 'staff', OR: [{ expiresAt: { lt: ago(90 * DAY) } }, { revokedAt: { lt: ago(90 * DAY) } }] },
    });
    const emails = await this.prisma.outboundEmail.deleteMany({ where: { templateKey: { startsWith: 'auth.' }, createdAt: { lt: ago(30 * DAY) } } });
    const [purged] = await this.prisma.$queryRaw<Array<{ n: number }>>`SELECT privacy_purge_expired() AS n`;
    return { tokens: tokens.count, customerSessions: customerSessions.count, staffSessions: staffSessions.count, emails: emails.count, auditValues: purged?.n ?? 0 };
  }
}
