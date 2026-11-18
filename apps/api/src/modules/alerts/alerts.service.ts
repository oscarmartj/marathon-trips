import { Inject, Injectable } from '@nestjs/common';
import { brand } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { AppConfig } from '../../platform/config/config';
import { newToken, tokenHash, looksLikeToken } from '../../platform/auth/tokens';
import { safeEqualHex } from '../../platform/crypto/hmac';
import { APP_CONFIG, PrismaService } from '../../platform/database/prisma.service';
import { AppError } from '../../platform/errors/safe-error';
import type { DeliveredEvent } from '../../platform/events/consumers';
import { OutboxService } from '../../platform/events/outbox.service';
import { ApiError, notFound } from '../../platform/http/api-error';
import { MailService } from '../../platform/mail/mail.service';
import type { RenderContext, RenderedMail } from '../../platform/mail/templates';
import { CONFIRM_TOKEN_MS, unsubscribeTokenFor } from './tokens';

type Tx = Prisma.TransactionClient;

const PUBLIC_RACE = { status: 'published', isDemo: false, deletedAt: null } satisfies Prisma.RaceWhereInput;
/** Alerts are for editions that are still ahead. */
const OPEN_EDITION = { status: { in: ['announced', 'active'] } } satisfies Prisma.RaceEditionWhereInput;

const linkInvalid = () => new ApiError(400, 'link_invalid', 'This link has expired or has already been used. Subscribe again to get a new one.');
/** Confirmation emails per address and 15 minutes; past it the request is accepted and nothing is sent. */
export const CONFIRMATIONS_PER_ADDRESS = 5;
const hourBucket = (now: number) => Math.floor(now / 3_600_000);

/** Opening alerts: double opt-in subscriptions, one-click unsubscribe and the notice sent when a package opens. */
@Injectable()
export class AlertsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  private webUrl(path: string): string {
    return `${new URL(this.config.WEB_ORIGIN).origin}${path}`;
  }

  unsubscribeUrl(subscriptionId: string): string {
    return this.webUrl(`/alerts/unsubscribe?s=${subscriptionId}&t=${unsubscribeTokenFor(this.config.EMAIL_HASH_KEY, subscriptionId)}`);
  }

  // ---- Subscribe ----

  /**
   * Accepts a request to be alerted. The answer is the same for a new address, a pending one and a confirmed one, so the
   * form cannot be used to find out who is subscribed. Only a published race (or an announced edition of it) is accepted.
   */
  async subscribe(input: { email: string; raceSlug: string; year?: number }, now: number = Date.now()): Promise<void> {
    const race = await this.prisma.race.findFirst({ where: { slug: input.raceSlug, ...PUBLIC_RACE }, select: { id: true } });
    if (!race) throw notFound('race_not_found', 'We could not find that race');
    let editionId: string | null = null;
    if (input.year !== undefined) {
      const edition = await this.prisma.raceEdition.findFirst({ where: { raceId: race.id, year: input.year, ...OPEN_EDITION }, select: { id: true } });
      if (!edition) throw notFound('edition_not_found', 'We could not find that edition');
      editionId = edition.id;
    }
    const scope = editionId ? `edition:${editionId}` : 'race';
    await this.prisma.$transaction(async (tx) => {
      // Task 8.5 (S-07): the cap is counted in the database (a restart or a flood of other addresses cannot reset it).
      if (!(await this.mail.withinAddressCap(tx, { to: input.email, templateKey: 'alerts.confirm', max: CONFIRMATIONS_PER_ADDRESS, windowMs: 15 * 60_000 }))) return;
      // The unique key makes two simultaneous requests land on one row.
      const row = (await tx.$queryRaw<Array<{ id: string; status: string }>>`
        INSERT INTO alert_subscriptions (id, email, "raceId", "editionId", scope, "updatedAt")
        VALUES (gen_random_uuid(), ${input.email}, ${race.id}::uuid, ${editionId}::uuid, ${scope}, now())
        ON CONFLICT (email, "raceId", scope) DO UPDATE SET "updatedAt" = now()
        RETURNING id, status::text AS status`)[0]!;
      if (row.status === 'confirmed') return;
      if (row.status === 'unsubscribed') {
        // Coming back needs a fresh confirmation.
        await tx.alertSubscription.updateMany({ where: { id: row.id, status: 'unsubscribed' }, data: { status: 'pending', unsubscribedAt: null, confirmedAt: null } });
      }
      await this.mail.enqueue({
        to: input.email, templateKey: 'alerts.confirm', templateVersion: 1, locale: 'en-AU',
        dedupeKey: `alerts:confirm:${row.id}:${hourBucket(now)}`, relatedEntityType: 'AlertSubscription', relatedEntityId: row.id,
      }, tx);
    });
  }

  /** Send step of the confirmation email. The token and its hash commit with the send; a retry replaces it. */
  async renderConfirm(ctx: RenderContext): Promise<RenderedMail> {
    const id = ctx.email.relatedEntityId;
    if (!id) throw new AppError('alert_confirm_missing_subscription', 'The email is not linked to a subscription');
    const token = newToken();
    const minted = await ctx.tx.alertSubscription.updateMany({
      where: { id, status: 'pending' },
      data: { confirmTokenHash: tokenHash(token), confirmTokenExpiresAt: new Date(Date.now() + CONFIRM_TOKEN_MS) },
    });
    if (minted.count !== 1) throw new AppError('alert_confirm_not_pending', 'The subscription is no longer waiting for confirmation');
    const sub = await ctx.tx.alertSubscription.findUniqueOrThrow({ where: { id }, select: { race: { select: { name: true } }, edition: { select: { year: true } } } });
    const what = this.describe(sub.race.name, sub.edition?.year ?? null);
    const name = brand.name;
    return {
      subject: `Confirm your ${name} alert for ${what}`,
      text: [
        'Hi,', '',
        `You asked us to let you know when travel packages open for ${what}. Confirm it is you with this link:`, '',
        this.webUrl(`/alerts/confirm#token=${token}`), '',
        'The link works once and expires in 7 days. If you did not ask for this, ignore this email and we will not write to you again.', '',
        `Unsubscribe: ${this.unsubscribeUrl(id)}`, '',
        name,
      ].join('\n'),
    };
  }

  /** Send step of the opening notice. It refuses to send to someone who unsubscribed after the event was recorded. */
  async renderOpen(ctx: RenderContext): Promise<RenderedMail> {
    const id = ctx.email.relatedEntityId;
    const mailRow = await ctx.tx.outboundEmail.findUniqueOrThrow({ where: { id: ctx.email.id }, select: { dedupeKey: true } });
    const packageId = /^alerts:open:([0-9a-f-]{36}):/.exec(mailRow.dedupeKey)?.[1];
    if (!id || !packageId) throw new AppError('alert_open_missing_reference', 'The email is not linked to a subscription and a package');
    const sub = await ctx.tx.alertSubscription.findUnique({ where: { id }, select: { status: true, race: { select: { slug: true, name: true } } } });
    if (!sub || sub.status !== 'confirmed') throw new AppError('alert_no_longer_confirmed', 'The subscription is no longer confirmed');
    const pkg = await ctx.tx.package.findUniqueOrThrow({ where: { id: packageId }, select: { name: true, slug: true, edition: { select: { year: true } } } });
    const raceName = this.localised(sub.race.name);
    const url = this.webUrl(`/races/${sub.race.slug}`);
    const name = brand.name;
    return {
      subject: `${raceName} ${pkg.edition.year}: ${this.localised(pkg.name)} is now open`,
      text: [
        'Hi,', '',
        `A travel package for ${raceName} ${pkg.edition.year} is now open: ${this.localised(pkg.name)}.`, '',
        `See it here: ${url}`, '',
        `You are getting this because you asked for an alert. Unsubscribe in one click: ${this.unsubscribeUrl(id)}`, '',
        name,
      ].join('\n'),
    };
  }

  // ---- Confirm and unsubscribe ----

  /** Single-use: the token is cleared by the same compare-and-set that confirms. */
  async confirm(token: string): Promise<void> {
    if (!looksLikeToken(token)) throw linkInvalid();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const sub = await tx.alertSubscription.findUnique({ where: { confirmTokenHash: tokenHash(token) }, select: { id: true, raceId: true, editionId: true } });
      if (!sub) throw linkInvalid();
      const res = await tx.alertSubscription.updateMany({
        where: { id: sub.id, status: 'pending', confirmTokenHash: tokenHash(token), confirmTokenExpiresAt: { gt: now } },
        data: { status: 'confirmed', confirmedAt: now, confirmTokenHash: null, confirmTokenExpiresAt: null },
      });
      if (res.count !== 1) throw linkInvalid();
      await this.outbox.publish(tx, {
        type: 'alerts.subscription.confirmed', aggregateType: 'AlertSubscription', aggregateId: sub.id,
        payload: { subscriptionId: sub.id, raceId: sub.raceId, editionId: sub.editionId }, actorType: 'system',
      });
    });
  }

  /** Idempotent. A wrong HMAC and an unknown id look the same. */
  async unsubscribe(subscriptionId: string, token: string): Promise<void> {
    if (!safeEqualHex(token, unsubscribeTokenFor(this.config.EMAIL_HASH_KEY, subscriptionId))) throw linkInvalid();
    await this.prisma.alertSubscription.updateMany({
      where: { id: subscriptionId, status: { in: ['pending', 'confirmed'] } },
      data: { status: 'unsubscribed', unsubscribedAt: new Date(), confirmTokenHash: null, confirmTokenExpiresAt: null },
    });
  }

  // ---- Opening notice (event consumer) ----

  /**
   * A package moved to `open`: one email to each confirmed subscriber of its race (or of its edition). The dedupe key
   * names the package and the subscription, so a repeated delivery sends nothing new.
   */
  async notifyOpen(event: DeliveredEvent, tx: Tx): Promise<number> {
    const p = event.payload as { packageId?: string; editionId?: string; raceId?: string; toStatus?: string };
    if (p.toStatus !== 'open' || !p.packageId || !p.editionId || !p.raceId) return 0;
    const subs = await tx.alertSubscription.findMany({
      where: { raceId: p.raceId, status: 'confirmed', OR: [{ editionId: null }, { editionId: p.editionId }] },
      select: { id: true, email: true, customerId: true },
      orderBy: { id: 'asc' },
    });
    for (const s of subs) {
      await this.mail.enqueue({
        to: s.email, templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', category: 'marketing',
        dedupeKey: `alerts:open:${p.packageId}:${s.id}`, relatedEntityType: 'AlertSubscription', relatedEntityId: s.id,
        ...(s.customerId ? { customerId: s.customerId } : {}),
      }, tx);
    }
    if (subs.length > 0) await tx.alertSubscription.updateMany({ where: { id: { in: subs.map((s) => s.id) } }, data: { lastNotifiedAt: new Date() } });
    return subs.length;
  }

  // ---- Panel ----

  /** Subscribers per race: counts only, never addresses. */
  async subscriberCounts(): Promise<Array<{ raceId: string; slug: string; name: unknown; confirmed: number; pending: number }>> {
    const groups = await this.prisma.alertSubscription.groupBy({ by: ['raceId', 'status'], where: { status: { in: ['pending', 'confirmed'] } }, _count: { _all: true } });
    const ids = [...new Set(groups.map((g) => g.raceId))];
    const races = await this.prisma.race.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, name: true } });
    return races
      .map((r) => ({
        raceId: r.id, slug: r.slug, name: r.name,
        confirmed: groups.find((g) => g.raceId === r.id && g.status === 'confirmed')?._count._all ?? 0,
        pending: groups.find((g) => g.raceId === r.id && g.status === 'pending')?._count._all ?? 0,
      }))
      .sort((a, b) => b.confirmed - a.confirmed || a.slug.localeCompare(b.slug));
  }

  private localised(value: unknown): string {
    const v = value && typeof value === 'object' ? (value as Record<string, unknown>)['en-AU'] : undefined;
    return typeof v === 'string' ? v : '';
  }

  private describe(raceName: unknown, year: number | null): string {
    return `${this.localised(raceName)}${year ? ` ${year}` : ''}`.trim();
  }
}
