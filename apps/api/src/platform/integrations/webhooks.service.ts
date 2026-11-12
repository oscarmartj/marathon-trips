import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CreateWebhookInput, UpdateWebhookInput } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { AuditActor, AuditService } from '../audit/audit.service';
import { SECRET_BOX } from '../auth/staff-auth.service';
import { SecretBox } from '../crypto/secret-box';
import { PrismaService } from '../database/prisma.service';
import { AppError } from '../errors/safe-error';
import { conflict, notFound, unprocessable } from '../http/api-error';
import { INTEGRATIONS_PERMISSIONS } from './permissions';
import { validateWebhookUrl } from './ssrf';
import { catalogueEntry, PING_EVENT_TYPE, pingBody, WEBHOOK_EVENT_CATALOGUE } from './webhook-catalogue';
import { WebhookDeliveryService, webhookSecretAad } from './webhook-delivery.service';
import { newWebhookSecret } from './webhook-signing';

export const MAX_ACTIVE_WEBHOOKS = 20;
export const ROTATION_OVERLAP_MS = 24 * 3600_000;

export interface WebhookView {
  id: string;
  description: string;
  /** Origin and a masked path: the full address can hold the receiver's own token, so it is never sent back. */
  urlDisplay: string;
  eventTypes: string[];
  enabled: boolean;
  disabledAt: string | null;
  disabledReason: string | null;
  consecutiveFailures: number;
  previousSecretValidUntil: string | null;
  createdAt: string;
  version: number;
}

export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname === '/' && !u.search ? '/' : '/…'}`;
  } catch {
    return '…';
  }
}

type Row = {
  id: string; description: string; url: string; eventTypes: string[]; enabled: boolean; disabledAt: Date | null; disabledReason: string | null;
  consecutiveFailures: number; previousExpiresAt: Date | null; createdAt: Date; version: number;
};
const VIEW_SELECT = {
  id: true, description: true, url: true, eventTypes: true, enabled: true, disabledAt: true, disabledReason: true, consecutiveFailures: true,
  previousExpiresAt: true, createdAt: true, version: true,
} as const;

const view = (r: Row, now: Date): WebhookView => ({
  id: r.id, description: r.description, urlDisplay: maskUrl(r.url), eventTypes: [...r.eventTypes].sort(), enabled: r.enabled,
  disabledAt: r.disabledAt?.toISOString() ?? null, disabledReason: r.disabledReason, consecutiveFailures: r.consecutiveFailures,
  previousSecretValidUntil: r.previousExpiresAt && r.previousExpiresAt > now ? r.previousExpiresAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(), version: r.version,
});

/**
 * Outgoing webhook administration (task 8.4, plan 4.1 and 11). The secret is returned once when it is created or
 * rotated; changing the address rotates it too and cancels what was queued for the old address.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(WebhookDeliveryService) private readonly deliveries: WebhookDeliveryService,
  ) {}

  async list(now: Date = new Date()): Promise<WebhookView[]> {
    const rows = await this.prisma.webhookSubscription.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, select: VIEW_SELECT });
    return rows.map((r) => view(r, now));
  }

  /** The event types the caller may subscribe to (holds each entry's read permission). */
  async catalogue(auth: AuthContext): Promise<Array<{ type: string; description: string }>> {
    const eff = await this.access.effectiveFor(this.prisma, auth);
    return WEBHOOK_EVENT_CATALOGUE.filter((e) => eff.keys.has(e.readPermission)).map((e) => ({ type: e.type, description: e.description }));
  }

  private checkUrl(raw: string): URL {
    try {
      return validateWebhookUrl(raw, this.deliveries.urlRules());
    } catch (e) {
      if (e instanceof AppError) throw unprocessable('invalid_url', e.message);
      throw e;
    }
  }

  private async checkEventTypes(tx: Prisma.TransactionClient, auth: AuthContext, types: readonly string[]): Promise<void> {
    const eff = await this.access.effectiveFor(tx, auth);
    for (const t of types) {
      const entry = catalogueEntry(t);
      if (!entry) throw unprocessable('unknown_event_type', 'One of the event types cannot be sent by webhook');
      if (!eff.keys.has(entry.readPermission)) throw unprocessable('event_type_not_readable', 'You cannot subscribe to an event you are not allowed to see');
    }
  }

  private encrypt(id: string, secret: string) {
    return this.box.encrypt(secret, webhookSecretAad(id));
  }

  async create(actor: AuditActor & { id: string }, auth: AuthContext, input: CreateWebhookInput, now: Date = new Date()) {
    this.checkUrl(input.url);
    const id = randomUUID();
    const secret = newWebhookSecret();
    const enc = this.encrypt(id, secret);
    return this.prisma.$transaction(async (tx) => {
      await this.access.lockUsers(tx, [auth.userId]);
      await this.access.lockedActor(tx, auth.userId, INTEGRATIONS_PERMISSIONS.webhookManage);
      await this.checkEventTypes(tx, auth, input.eventTypes);
      // Serialises creations: two parallel requests cannot both pass the count.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('webhook_subscriptions:create'))`;
      const active = await tx.webhookSubscription.count({ where: { deletedAt: null } });
      if (active >= MAX_ACTIVE_WEBHOOKS) throw unprocessable('too_many_webhooks', `There can be at most ${MAX_ACTIVE_WEBHOOKS} webhooks`);
      const row = await tx.webhookSubscription.create({
        data: {
          id, description: input.description, url: input.url, eventTypes: [...input.eventTypes].sort(), secretCiphertext: enc.ciphertext, keyVersion: enc.keyVersion,
          createdById: actor.id, createdAt: now,
        },
        select: VIEW_SELECT,
      });
      await this.audit.record(tx, {
        actor, action: 'integrations.webhook.created', entityType: 'WebhookSubscription', entityId: id,
        after: { description: input.description, url: input.url, eventTypes: row.eventTypes, enabled: true, secretCiphertext: enc.ciphertext },
      });
      return { webhook: view(row, now), secret };
    });
  }

  private async locked(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM webhook_subscriptions WHERE id = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (rows.length === 0) throw notFound('webhook_not_found', 'Webhook not found');
    return tx.webhookSubscription.findUniqueOrThrow({ where: { id }, select: { ...VIEW_SELECT, secretCiphertext: true, keyVersion: true } });
  }

  async update(actor: AuditActor & { id: string }, auth: AuthContext, id: string, input: UpdateWebhookInput, now: Date = new Date()) {
    if (input.url !== undefined) this.checkUrl(input.url);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.locked(tx, id);
      if (before.version !== input.version) throw conflict('version_conflict', 'Someone else changed this webhook; reload and try again');
      if (input.eventTypes) await this.checkEventTypes(tx, auth, input.eventTypes);
      const data: Prisma.WebhookSubscriptionUpdateInput = { version: { increment: 1 } };
      const after: Record<string, unknown> = {};
      const was: Record<string, unknown> = {};
      if (input.description !== undefined && input.description !== before.description) {
        data.description = input.description; was.description = before.description; after.description = input.description;
      }
      if (input.eventTypes) {
        const sorted = [...input.eventTypes].sort();
        data.eventTypes = sorted; was.eventTypes = before.eventTypes; after.eventTypes = sorted;
      }
      let secret: string | null = null;
      if (input.url !== undefined && input.url !== before.url) {
        // A new address is a new receiver: queued deliveries for the old one are cancelled, and it gets its own secret.
        secret = newWebhookSecret();
        const enc = this.encrypt(id, secret);
        Object.assign(data, { url: input.url, secretCiphertext: enc.ciphertext, keyVersion: enc.keyVersion, previousSecretCiphertext: null, previousKeyVersion: null, previousExpiresAt: null });
        was.url = before.url; after.url = input.url; was.secretCiphertext = before.secretCiphertext; after.secretCiphertext = enc.ciphertext;
        await this.deliveries.cancelPending(tx, id, 'url_changed');
      }
      if (input.enabled !== undefined && input.enabled !== before.enabled) {
        Object.assign(data, input.enabled
          ? { enabled: true, disabledAt: null, disabledReason: null, consecutiveFailures: 0 }
          : { enabled: false, disabledAt: now, disabledReason: 'manual' });
        was.enabled = before.enabled; after.enabled = input.enabled;
      }
      const row = await tx.webhookSubscription.update({ where: { id }, data, select: VIEW_SELECT });
      if (Object.keys(after).length > 0) {
        await this.audit.record(tx, { actor, action: 'integrations.webhook.updated', entityType: 'WebhookSubscription', entityId: id, before: was, after });
      }
      return { webhook: view(row, now), ...(secret ? { secret } : {}) };
    });
  }

  /** Soft delete: the row stays for the deliveries and the audit log, but the address and secrets are emptied. */
  async remove(actor: AuditActor & { id: string }, id: string, now: Date = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.locked(tx, id);
      await tx.webhookSubscription.update({
        where: { id },
        data: {
          deletedAt: now, deletedById: actor.id, enabled: false, disabledAt: before.disabledAt ?? now, disabledReason: before.disabledReason ?? 'manual',
          url: '', secretCiphertext: '', previousSecretCiphertext: null, previousKeyVersion: null, previousExpiresAt: null, version: { increment: 1 },
        },
      });
      await this.deliveries.cancelPending(tx, id, 'subscription_disabled');
      await this.audit.record(tx, {
        actor, action: 'integrations.webhook.deleted', entityType: 'WebhookSubscription', entityId: id,
        before: { url: before.url, deletedAt: null, secretCiphertext: before.secretCiphertext }, after: { url: '', deletedAt: now, secretCiphertext: '' },
      });
    });
  }

  /** New secret, shown once; the old one still signs for 24 hours so the receiver can switch without losing events. */
  async rotate(actor: AuditActor & { id: string }, id: string, now: Date = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.locked(tx, id);
      const secret = newWebhookSecret();
      const enc = this.encrypt(id, secret);
      const row = await tx.webhookSubscription.update({
        where: { id },
        data: {
          secretCiphertext: enc.ciphertext, keyVersion: enc.keyVersion, previousSecretCiphertext: before.secretCiphertext, previousKeyVersion: before.keyVersion,
          previousExpiresAt: new Date(now.getTime() + ROTATION_OVERLAP_MS), version: { increment: 1 },
        },
        select: VIEW_SELECT,
      });
      await this.audit.record(tx, {
        actor, action: 'integrations.webhook.secretRotated', entityType: 'WebhookSubscription', entityId: id,
        before: { secretCiphertext: before.secretCiphertext }, after: { secretCiphertext: enc.ciphertext },
      });
      return { webhook: view(row, now), secret };
    });
  }

  /** Queues an integrations.ping delivery to this webhook, whatever event types it has. */
  async test(actor: AuditActor & { id: string }, id: string, now: Date = new Date()): Promise<{ deliveryId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const sub = await this.locked(tx, id);
      if (!sub.enabled) throw conflict('subscription_disabled', 'Turn the webhook back on first');
      const eventId = randomUUID();
      await this.deliveries.insertDelivery(tx, id, eventId, PING_EVENT_TYPE, pingBody(id, now));
      const d = await tx.webhookDelivery.findUniqueOrThrow({ where: { subscriptionId_eventId: { subscriptionId: id, eventId } }, select: { id: true } });
      await this.audit.record(tx, { actor, action: 'integrations.webhook.tested', entityType: 'WebhookSubscription', entityId: id, context: { deliveryId: d.id } });
      return { deliveryId: d.id };
    });
  }

  async listDeliveries(id: string) {
    const sub = await this.prisma.webhookSubscription.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
    if (!sub || sub.deletedAt) throw notFound('webhook_not_found', 'Webhook not found');
    const rows = await this.prisma.webhookDelivery.findMany({
      where: { subscriptionId: id }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, eventId: true, eventType: true, status: true, attempts: true, nextAttemptAt: true, lastAttemptAt: true, succeededAt: true, lastResponseStatus: true, lastDurationMs: true, lastErrorCode: true, createdAt: true },
    });
    return rows.map((r) => ({
      ...r, nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null, lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
      succeededAt: r.succeededAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    }));
  }
}
