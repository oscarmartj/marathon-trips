import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { SettingsService } from '../../../platform/flags/flags.service';
import { type BreakerCode, type HealthCounters, afterFailure, afterSuccess } from './routing-rules';
import { PAYMENT_SETTINGS } from './settings';

async function txNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now` as [{ now: Date }];
  return now;
}

const HEALTH_SELECT = { consecutiveFailures: true, lastFailureAt: true, lastFailureCode: true, openedAt: true, openUntil: true, probeUntil: true, lastSuccessAt: true } as const;

/**
 * Gateway health (task 4.2, plan sections 3 and 15.2 to 15.6): written only by ProviderGateway after a call to a stored
 * account (never by a test of candidate credentials). One row per account, read and written under its row lock, so
 * concurrent failures open the breaker once. Best effort: a failure here never changes the result of the call.
 * It never changes an account's status and never touches an attempt.
 */
@Injectable()
export class ProviderHealthService {
  private readonly logger = new Logger('PaymentHealth');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The database clock: every health time is read and compared on it, never on an instance's clock (review B2). */
  async dbNow(): Promise<Date> {
    const [{ now }] = await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now` as [{ now: Date }];
    return now;
  }

  async failure(accountId: string, code: BreakerCode): Promise<void> {
    try {
      const s = {
        failures: await this.settings.get(PAYMENT_SETTINGS.breakerFailures.key, PAYMENT_SETTINGS.breakerFailures.fallback),
        windowSeconds: await this.settings.get(PAYMENT_SETTINGS.breakerWindowSeconds.key, PAYMENT_SETTINGS.breakerWindowSeconds.fallback),
        cooldownSeconds: await this.settings.get(PAYMENT_SETTINGS.breakerCooldownSeconds.key, PAYMENT_SETTINGS.breakerCooldownSeconds.fallback),
      };
      await this.prisma.$transaction(async (tx) => {
        const prev = await this.lockRow(tx, accountId);
        const now = await txNow(tx);
        const next = afterFailure(prev, code, now, s);
        await tx.providerAccountHealth.update({ where: { providerAccountId: accountId }, data: { ...next, updatedAt: now } });
        if (!prev.openedAt && next.openedAt) {
          await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'payments.providerAccount.unreachable', entityType: 'ProviderAccount', entityId: accountId, context: { code, failures: next.consecutiveFailures } });
        }
      });
    } catch (err) {
      this.logger.warn(`health not recorded for account ${accountId}: ${(err as { code?: string }).code ?? 'error'}`);
    }
  }

  /**
   * A successful create or ok connection test that started at `startedAt` (database clock); ignored when a failure was
   * recorded after it started (15.6). Reads, cancellations and refunds never close the breaker (review M1).
   */
  async success(accountId: string, startedAt: Date): Promise<void> {
    try {
      const row = await this.prisma.providerAccountHealth.findUnique({ where: { providerAccountId: accountId }, select: HEALTH_SELECT });
      // Nothing to reset: no row, or already clean (keeps the hot path to one read).
      if (!row || (row.consecutiveFailures === 0 && !row.openUntil && !row.probeUntil)) return;
      await this.prisma.$transaction(async (tx) => {
        const prev = await this.lockRow(tx, accountId);
        const now = await txNow(tx);
        const next = afterSuccess(prev, startedAt, now);
        if (!next) return;
        await tx.providerAccountHealth.update({ where: { providerAccountId: accountId }, data: { ...next, updatedAt: now } });
        if (prev.openedAt) await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'payments.providerAccount.reachable', entityType: 'ProviderAccount', entityId: accountId, context: {} });
      });
    } catch (err) {
      this.logger.warn(`health not recorded for account ${accountId}: ${(err as { code?: string }).code ?? 'error'}`);
    }
  }

  /** Credentials that tested ok were stored (plan 15.6): the account starts clean, inside the caller's transaction. */
  async reset(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
    const now = await txNow(tx);
    await tx.providerAccountHealth.updateMany({ where: { providerAccountId: accountId }, data: { consecutiveFailures: 0, openedAt: null, openUntil: null, probeUntil: null, lastSuccessAt: now, updatedAt: now } });
  }

  private async lockRow(tx: Prisma.TransactionClient, accountId: string): Promise<HealthCounters> {
    await tx.$executeRaw`INSERT INTO provider_account_health ("providerAccountId") VALUES (${accountId}::uuid) ON CONFLICT DO NOTHING`;
    const rows = await tx.$queryRaw<HealthCounters[]>`
      SELECT "consecutiveFailures", "lastFailureAt", "lastFailureCode", "openedAt", "openUntil", "probeUntil", "lastSuccessAt"
      FROM provider_account_health WHERE "providerAccountId" = ${accountId}::uuid FOR UPDATE`;
    return rows[0]!;
  }
}
