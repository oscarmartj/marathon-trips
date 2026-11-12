import { Inject, Injectable, Logger } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { Prisma } from '../../generated/prisma/client';
import { AuditActor, AuditService, SYSTEM_ACTOR } from '../audit/audit.service';
import { SECRET_BOX } from '../auth/staff-auth.service';
import type { AppConfig } from '../config/config';
import { SecretBox } from '../crypto/secret-box';
import { bossDb } from '../database/boss-db';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { AppError, safeError } from '../errors/safe-error';
import type { DeliveredEvent } from '../events/consumers';
import { FeatureFlagService } from '../flags/flags.service';
import { assertIdentifiersOnly } from '../guards/no-personal-data';
import { conflict, notFound, tooManyRequests } from '../http/api-error';
import { JobsService } from '../jobs/jobs.service';
import { QUEUES } from '../jobs/queues';
import { INTEGRATIONS_MODULE } from './permissions';
import { pickAddress, Resolver, validateWebhookUrl, type UrlRules } from './ssrf';
import { buildOutboundBody, catalogueEntry, OutboundBody } from './webhook-catalogue';
import { postWebhook } from './webhook-http';
import { signatureHeader } from './webhook-signing';

/** Seconds to wait after failed attempt n before attempt n + 1 (index n). Seven attempts over about 21 hours. */
export const RETRY_SCHEDULE_SECONDS = [0, 60, 300, 1800, 7200, 21600, 43200] as const;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length;
export const AUTO_DISABLE_AFTER_FAILURES = 50;
export const LEASE_MS = 60_000;
export const SEND_TIMEOUT_MS = 10_000;
export const DELIVERY_RETENTION_DAYS = 30;
export const MANUAL_RETRIES_PER_DAY = 5;
const DAY_MS = 24 * 3600_000;

/** The closed list of codes stored in lastErrorCode (plan 4.5). Never a message from the receiver or the error. */
export const DELIVERY_ERROR_CODES = [
  'timeout', 'connection_failed', 'tls_error', 'dns_failed', 'blocked_address', 'invalid_url', 'http_redirect', 'http_error',
  'secret_unavailable', 'module_disabled', 'subscription_disabled', 'url_changed', 'not_allow_listed',
] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];
const FINAL_CODES: ReadonlySet<DeliveryErrorCode> = new Set(['blocked_address', 'invalid_url', 'secret_unavailable']);

export const webhookSecretAad = (subscriptionId: string): string => `webhook_subscription:${subscriptionId}`;

const defaultResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

export type SendOutcome = 'noop' | 'succeeded' | 'retry' | 'failed' | 'suppressed' | 'cancelled';

/** Origins that outgoing webhooks may reach outside production. Ignored in production (the warning is logged at start). */
export function devAllowlist(config: Pick<AppConfig, 'APP_ENV' | 'WEBHOOK_DEV_ALLOWLIST'>): { origins: ReadonlySet<string>; warning?: string } {
  const entries = config.WEBHOOK_DEV_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
  if (config.APP_ENV === 'production') {
    return { origins: new Set(), ...(entries.length ? { warning: 'WEBHOOK_DEV_ALLOWLIST is ignored because APP_ENV is production' } : {}) };
  }
  const origins = new Set<string>();
  for (const e of entries) {
    try {
      origins.add(new URL(e).origin);
    } catch {
      // A malformed entry allows nothing.
    }
  }
  return { origins };
}

/**
 * Outgoing webhook deliveries (task 8.4, plan 4.3 to 4.5 and 11): fan-out from the outbox, the send job in three
 * steps (claim, send outside any transaction, record with compare-and-set), the maintenance sweep and the counters
 * that switch off a failing subscription. `timeoutMs` and `resolver` are seams for tests.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger('Webhooks');
  timeoutMs = SEND_TIMEOUT_MS;
  resolver: Resolver = defaultResolver;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
  ) {}

  get production(): boolean {
    return this.config.APP_ENV === 'production';
  }

  urlRules(): UrlRules {
    return { production: this.production, ownHost: new URL(this.config.WEB_ORIGIN).hostname };
  }

  /**
   * The outbox consumer: one delivery per live subscription to this type that existed when the event happened, in
   * the consumer's transaction (insert-or-nothing, so running twice leaves one row). A payload that breaks its
   * contract throws: the event delivery is retried and then marked failed, visible in the monitor.
   */
  async fanOut(event: DeliveredEvent, tx: Prisma.TransactionClient): Promise<number> {
    if (!catalogueEntry(event.type)) return 0;
    const subs = await tx.webhookSubscription.findMany({
      where: { enabled: true, deletedAt: null, eventTypes: { has: event.type }, createdAt: { lte: event.occurredAt } },
      select: { id: true },
    });
    if (subs.length === 0) return 0;
    const body = buildOutboundBody(event);
    assertIdentifiersOnly('event payload', body.data);
    let created = 0;
    for (const s of subs) created += await this.insertDelivery(tx, s.id, event.id, event.type, body);
    return created;
  }

  /** Inserts a pending delivery and its job in `tx`; nothing if the pair already exists. */
  async insertDelivery(tx: Prisma.TransactionClient, subscriptionId: string, eventId: string, eventType: string, body: OutboundBody): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO webhook_deliveries (id, "subscriptionId", "eventId", "eventType", body)
      VALUES (gen_random_uuid(), ${subscriptionId}::uuid, ${eventId}::uuid, ${eventType}, ${JSON.stringify(body)}::jsonb)
      ON CONFLICT ("subscriptionId", "eventId") DO NOTHING
      RETURNING id`;
    for (const r of rows) await this.jobs.send(QUEUES.webhooksSend, { deliveryId: r.id }, { db: bossDb(tx), singletonKey: `${r.id}:0` });
    return rows.length;
  }

  /** The `webhooks.send` job. Safe to run twice at once: only one claim succeeds. */
  async processSend(deliveryId: string, now: Date = new Date()): Promise<SendOutcome> {
    const claim = await this.claim(deliveryId, now);
    if (claim.kind !== 'send') return claim.kind;

    let result: { ok: boolean; status: number | null; durationMs: number; errorCode: DeliveryErrorCode | null };
    const started = Date.now();
    try {
      const pinned = await pickAddress(claim.host, this.resolver, claim.allowLoopback);
      const ts = Math.floor(Date.now() / 1000);
      const r = await postWebhook(claim.url, pinned, {
        'content-type': 'application/json',
        'user-agent': 'MarathonTrips-Webhooks/1',
        'webhook-id': deliveryId,
        'webhook-timestamp': String(ts),
        'webhook-signature': signatureHeader(claim.secrets, deliveryId, ts, claim.body),
      }, claim.body, { timeoutMs: this.timeoutMs });
      result = r;
    } catch (err) {
      const code = safeError(err).code;
      result = { ok: false, status: null, durationMs: Date.now() - started, errorCode: code === 'blocked_address' || code === 'dns_failed' ? code : 'connection_failed' };
    }
    return this.record(deliveryId, claim.attempts, claim.subscriptionId, result, new Date());
  }

  private async claim(deliveryId: string, now: Date): Promise<
    | { kind: 'noop' | 'suppressed' | 'cancelled' | 'failed' }
    | { kind: 'send'; attempts: number; subscriptionId: string; url: URL; host: string; allowLoopback: boolean; secrets: string[]; body: string }
  > {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ attempts: number; subscriptionId: string; body: unknown }>>`
        UPDATE webhook_deliveries SET status = 'sending', attempts = attempts + 1, "leaseUntil" = ${new Date(now.getTime() + LEASE_MS)}::timestamptz,
          "lastAttemptAt" = ${now}::timestamptz
        WHERE id = ${deliveryId}::uuid AND status = 'pending' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now}::timestamptz)
        RETURNING attempts, "subscriptionId", body`;
      const row = rows[0];
      if (!row) return { kind: 'noop' as const };
      const end = async (status: 'cancelled' | 'suppressed' | 'failed', code: DeliveryErrorCode) => {
        await tx.webhookDelivery.update({ where: { id: deliveryId }, data: { status, lastErrorCode: code, leaseUntil: null, nextAttemptAt: null } });
      };
      if (!(await this.flags.isModuleEnabled(INTEGRATIONS_MODULE, tx))) {
        await end('cancelled', 'module_disabled');
        return { kind: 'cancelled' as const };
      }
      const sub = await tx.webhookSubscription.findUniqueOrThrow({
        where: { id: row.subscriptionId },
        select: { url: true, enabled: true, deletedAt: true, secretCiphertext: true, keyVersion: true, previousSecretCiphertext: true, previousKeyVersion: true, previousExpiresAt: true },
      });
      if (!sub.enabled || sub.deletedAt) {
        await end('cancelled', 'subscription_disabled');
        return { kind: 'cancelled' as const };
      }
      let url: URL;
      try {
        url = validateWebhookUrl(sub.url, this.urlRules());
      } catch {
        await end('failed', 'invalid_url');
        await this.countFailure(tx, row.subscriptionId, now);
        return { kind: 'failed' as const };
      }
      const allowListed = !this.production && devAllowlist(this.config).origins.has(url.origin);
      if (!this.production && !allowListed) {
        // Development guard (plan 4.8): outside production nothing leaves for an address nobody listed.
        await end('suppressed', 'not_allow_listed');
        return { kind: 'suppressed' as const };
      }
      const secrets: string[] = [];
      try {
        secrets.push(this.box.decrypt(sub.secretCiphertext, sub.keyVersion, webhookSecretAad(row.subscriptionId)));
        if (sub.previousSecretCiphertext && sub.previousKeyVersion && sub.previousExpiresAt && sub.previousExpiresAt > now) {
          secrets.push(this.box.decrypt(sub.previousSecretCiphertext, sub.previousKeyVersion, webhookSecretAad(row.subscriptionId)));
        }
      } catch {
        await end('failed', 'secret_unavailable');
        await this.countFailure(tx, row.subscriptionId, now);
        return { kind: 'failed' as const };
      }
      return {
        kind: 'send' as const, attempts: row.attempts, subscriptionId: row.subscriptionId, url, host: url.hostname.replace(/^\[|\]$/g, ''),
        allowLoopback: allowListed, secrets, body: JSON.stringify(row.body),
      };
    });
  }

  private async record(
    deliveryId: string, attempts: number, subscriptionId: string,
    r: { ok: boolean; status: number | null; durationMs: number; errorCode: DeliveryErrorCode | null }, now: Date,
  ): Promise<SendOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const base = { leaseUntil: null, lastResponseStatus: r.status, lastDurationMs: r.durationMs, lastErrorCode: r.errorCode };
      if (r.ok) {
        const res = await tx.webhookDelivery.updateMany({ where: { id: deliveryId, status: 'sending', attempts }, data: { ...base, status: 'succeeded', succeededAt: now, nextAttemptAt: null } });
        if (res.count === 0) return 'noop' as const;
        await tx.webhookSubscription.updateMany({ where: { id: subscriptionId, consecutiveFailures: { gt: 0 } }, data: { consecutiveFailures: 0 } });
        return 'succeeded' as const;
      }
      const retry = attempts < MAX_ATTEMPTS && !FINAL_CODES.has(r.errorCode ?? 'connection_failed');
      const next = retry ? new Date(now.getTime() + RETRY_SCHEDULE_SECONDS[attempts]! * 1000) : null;
      const res = await tx.webhookDelivery.updateMany({
        where: { id: deliveryId, status: 'sending', attempts },
        data: { ...base, status: retry ? 'pending' : 'failed', nextAttemptAt: next },
      });
      if (res.count === 0) return 'noop' as const;
      if (retry) await this.jobs.send(QUEUES.webhooksSend, { deliveryId }, { db: bossDb(tx), singletonKey: `${deliveryId}:${attempts}`, startAfter: next! });
      this.logger.warn(`delivery ${deliveryId} attempt ${attempts} failed: ${r.errorCode ?? 'unknown'}`);
      await this.countFailure(tx, subscriptionId, now);
      return retry ? ('retry' as const) : ('failed' as const);
    });
  }

  /** One more failure in a row; at the threshold the subscription is switched off once, audited, and its queue cancelled. */
  private async countFailure(tx: Prisma.TransactionClient, subscriptionId: string, now: Date): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ failures: number }>>`
      UPDATE webhook_subscriptions SET "consecutiveFailures" = "consecutiveFailures" + 1 WHERE id = ${subscriptionId}::uuid
      RETURNING "consecutiveFailures" AS failures`;
    if ((rows[0]?.failures ?? 0) < AUTO_DISABLE_AFTER_FAILURES) return;
    const off = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE webhook_subscriptions SET enabled = false, "disabledAt" = ${now}::timestamptz, "disabledReason" = 'consecutive_failures',
        version = version + 1, "updatedAt" = ${now}::timestamptz
      WHERE id = ${subscriptionId}::uuid AND "disabledAt" IS NULL
      RETURNING id`;
    if (off.length === 0) return;
    await this.audit.record(tx, {
      actor: SYSTEM_ACTOR, action: 'integrations.webhook.autoDisabled', entityType: 'WebhookSubscription', entityId: subscriptionId,
      before: { enabled: true, disabledReason: null }, after: { enabled: false, disabledReason: 'consecutive_failures' },
      context: { failures: AUTO_DISABLE_AFTER_FAILURES },
    });
    await this.cancelPending(tx, subscriptionId, 'subscription_disabled');
  }

  async cancelPending(tx: Prisma.TransactionClient, subscriptionId: string, code: DeliveryErrorCode): Promise<number> {
    const r = await tx.webhookDelivery.updateMany({ where: { subscriptionId, status: 'pending' }, data: { status: 'cancelled', lastErrorCode: code, nextAttemptAt: null } });
    return r.count;
  }

  /**
   * Every 5 minutes: sends whose API died mid-flight (lease passed) go back to pending; due pending deliveries without
   * a job get one; finished deliveries older than 30 days are deleted. With the module off nothing is re-queued.
   */
  async maintenance(now: Date = new Date()): Promise<{ requeued: number; purged: number }> {
    const purged = await this.prisma.webhookDelivery.deleteMany({
      where: { status: { in: ['succeeded', 'failed', 'suppressed', 'cancelled'] }, createdAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_DAYS * DAY_MS) } },
    });
    if (!(await this.flags.isModuleEnabled(INTEGRATIONS_MODULE))) return { requeued: 0, purged: purged.count };
    const requeued = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE webhook_deliveries SET status = 'failed', "leaseUntil" = NULL, "lastErrorCode" = 'timeout'
        WHERE status = 'sending' AND "leaseUntil" < ${now}::timestamptz AND attempts >= ${MAX_ATTEMPTS}`;
      await tx.$executeRaw`
        UPDATE webhook_deliveries SET status = 'pending', "leaseUntil" = NULL, "nextAttemptAt" = ${now}::timestamptz, "lastErrorCode" = 'timeout'
        WHERE status = 'sending' AND "leaseUntil" < ${now}::timestamptz`;
      const due = await tx.$queryRaw<Array<{ id: string; attempts: number }>>`
        SELECT id, attempts FROM webhook_deliveries
        WHERE status = 'pending' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now}::timestamptz)
        ORDER BY "createdAt" LIMIT 500`;
      for (const d of due) await this.jobs.send(QUEUES.webhooksSend, { deliveryId: d.id }, { db: bossDb(tx), singletonKey: `${d.id}:${d.attempts}:sweep` });
      return due.length;
    });
    return { requeued, purged: purged.count };
  }

  /** Manual retry of a failed delivery (panel, step-up): back to pending with its attempts reset, five times a day at most. */
  async retry(actor: AuditActor, deliveryId: string, now: Date = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string; subscriptionId: string }>>`
        SELECT status, "subscriptionId" FROM webhook_deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE`;
      const d = locked[0];
      if (!d) throw notFound('delivery_not_found', 'Delivery not found');
      if (d.status !== 'failed') throw conflict('delivery_not_failed', 'Only a failed delivery can be retried');
      const sub = await tx.webhookSubscription.findUniqueOrThrow({ where: { id: d.subscriptionId }, select: { enabled: true, deletedAt: true } });
      if (!sub.enabled || sub.deletedAt) throw conflict('subscription_disabled', 'Turn the webhook back on first');
      const recent = await tx.auditLog.count({ where: { action: 'integrations.webhookDelivery.retried', entityId: deliveryId, occurredAt: { gt: new Date(now.getTime() - DAY_MS) } } });
      if (recent >= MANUAL_RETRIES_PER_DAY) throw tooManyRequests(3600);
      await tx.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'pending', attempts: 0, nextAttemptAt: null, leaseUntil: null, lastErrorCode: null } });
      await this.jobs.send(QUEUES.webhooksSend, { deliveryId }, { db: bossDb(tx), singletonKey: `${deliveryId}:manual:${recent}` });
      await this.audit.record(tx, {
        actor, action: 'integrations.webhookDelivery.retried', entityType: 'WebhookDelivery', entityId: deliveryId,
        before: { status: 'failed' }, after: { status: 'pending' },
      });
    });
  }

  /** Thrown errors carry codes only; this turns an unexpected one into a log line without values. */
  logUnexpected(err: unknown): void {
    if (!(err instanceof AppError)) this.logger.error(`webhook job failed: ${safeError(err).code}`);
  }
}
