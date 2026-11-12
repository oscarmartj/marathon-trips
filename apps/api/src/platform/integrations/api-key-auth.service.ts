import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { ApiKeyAuth } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { Lru, WindowLimiter } from '../auth/attempt-limiter';
import type { AppConfig } from '../config/config';
import { safeEqualHex } from '../crypto/hmac';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { safeError } from '../errors/safe-error';
import { FeatureFlagService } from '../flags/flags.service';
import { tooManyRequests, unauthorised } from '../http/api-error';
import { apiKeySecretHash, parseApiKey } from './api-key-token';
import { INTEGRATIONS_MODULE } from './permissions';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Compared against when the prefix is unknown, so an unknown prefix costs the same HMAC as a wrong secret. */
const DUMMY_HASH = '0'.repeat(64);

export type ApiKeyRejection = 'malformed' | 'unknown_or_wrong_secret' | 'module_off' | 'revoked' | 'expired' | 'owner_inactive';

/** Failed authentications per IP in a sliding minute. Reading the count does not add to it. */
class FailureCounter {
  private readonly entries = new Lru<number[]>(10_000, MINUTE);

  constructor(private readonly max: number) {}

  over(ip: string, now = Date.now()): boolean {
    return (this.entries.get(ip, now) ?? []).filter((t) => t > now - MINUTE).length >= this.max;
  }

  record(ip: string, now = Date.now()): void {
    const recent = (this.entries.get(ip, now) ?? []).filter((t) => t > now - MINUTE);
    this.entries.set(ip, [...recent, now].slice(-this.max - 1), now);
  }
}

/**
 * Authenticates `Authorization: Bearer mtk_…` on permission routes (task 8.4, plan sections 3.1 and 11).
 *
 * - Every failure gets the same 401 `invalid_api_key`; the real reason goes to a warning with the prefix, never the token.
 * - A client IP over API_KEY_FAILED_PER_MINUTE failures still has its key checked: a valid key passes (subject to its
 *   own limit) and only a failure answers 429 instead of 401, so nobody can lock out a valid key (G3).
 * - Use of a revoked or expired key is audited at most once per key and hour.
 * - In memory, so the limits hold per API instance (one instance, plan 2).
 */
@Injectable()
export class ApiKeyAuthService {
  private readonly logger = new Logger('ApiKeys');
  private readonly perKey: WindowLimiter;
  private readonly failures: FailureCounter;
  private readonly rejectedUseAudited = new Lru<true>(10_000, HOUR);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.perKey = new WindowLimiter(config.API_KEY_RATE_LIMIT_PER_MINUTE, MINUTE);
    this.failures = new FailureCounter(config.API_KEY_FAILED_PER_MINUTE);
  }

  async authenticate(req: Request, now: Date = new Date()): Promise<ApiKeyAuth> {
    const ip = req.ip ?? 'unknown';
    const ipOver = this.failures.over(ip, now.getTime());
    const parsed = parseApiKey(req);
    const reject = (reason: ApiKeyRejection, prefix?: string): never => {
      this.failures.record(ip, now.getTime());
      this.logger.warn(`api key rejected: ${reason}${prefix ? ` (prefix ${prefix})` : ''}`);
      throw ipOver ? tooManyRequests(60) : unauthorised('invalid_api_key', 'The API key is not valid');
    };
    if (!parsed) return reject('malformed');

    const row = await this.prisma.apiKey.findUnique({
      where: { prefix: parsed.prefix },
      select: { id: true, secretHash: true, scopes: true, ownerUserId: true, expiresAt: true, revokedAt: true, owner: { select: { kind: true, status: true } } },
    });
    const presented = apiKeySecretHash(this.config.AUTH_HMAC_KEY, parsed.prefix, parsed.secret);
    if (!safeEqualHex(presented, row?.secretHash ?? DUMMY_HASH) || !row) return reject('unknown_or_wrong_secret', parsed.prefix);
    if (!(await this.flags.isModuleEnabled(INTEGRATIONS_MODULE))) return reject('module_off', parsed.prefix);
    if (row.revokedAt) {
      await this.auditRejectedUse(row.id, 'revoked', req, now);
      return reject('revoked', parsed.prefix);
    }
    if (row.expiresAt <= now) {
      await this.auditRejectedUse(row.id, 'expired', req, now);
      return reject('expired', parsed.prefix);
    }
    if (row.owner.kind !== 'staff' || row.owner.status !== 'active') return reject('owner_inactive', parsed.prefix);

    if (!this.perKey.allow(row.id, now.getTime())) throw tooManyRequests(60);
    await this.prisma.$executeRaw`
      UPDATE api_keys SET "lastUsedAt" = ${now}::timestamptz
      WHERE id = ${row.id}::uuid AND ("lastUsedAt" IS NULL OR "lastUsedAt" < ${new Date(now.getTime() - MINUTE)}::timestamptz)`;
    return { via: 'api_key', kind: 'staff', userId: row.ownerUserId, sessionId: null, mfaVerifiedAt: null, apiKeyId: row.id, scopes: new Set(row.scopes) };
  }

  /** At most once per key and hour (in memory), so a client retrying a dead key cannot flood the audit log. */
  private async auditRejectedUse(apiKeyId: string, reason: 'revoked' | 'expired', req: Request, now: Date): Promise<void> {
    if (this.rejectedUseAudited.get(apiKeyId, now.getTime())) return;
    this.rejectedUseAudited.set(apiKeyId, true, now.getTime());
    try {
      await this.prisma.$transaction((tx) =>
        this.audit.record(tx, {
          actor: { type: 'api_key', id: apiKeyId, sessionId: null, requestId: (req as Request & { requestId?: string }).requestId ?? null },
          action: 'integrations.apiKey.rejectedUse', entityType: 'ApiKey', entityId: apiKeyId, context: { reason },
        }),
      );
    } catch (err) {
      // Auditing a refused request must not turn the 401 into a 500.
      this.logger.error(`could not audit rejected api key use: ${safeError(err).code}`);
    }
  }
}
