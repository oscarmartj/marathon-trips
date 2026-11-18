import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { brand } from '@mt/shared';
import { AuditService } from '../audit/audit.service';
import type { AppConfig } from '../config/config';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { AppError } from '../errors/safe-error';
import { OutboxService } from '../events/outbox.service';
import { ApiError } from '../http/api-error';
import { MailService } from '../mail/mail.service';
import { MailTemplateRegistry, RenderContext } from '../mail/templates';
import type { RequestMeta } from './request-meta';
import { SessionService } from './session.service';
import { looksLikeToken, newToken, tokenHash } from './tokens';

export const MAGIC_LINK_MS = 15 * 60_000;
export const MAGIC_LINK_TEMPLATE = { key: 'auth.magic_link', version: 1 } as const;
/** Emails per address in 15 minutes; past it the request is accepted and nothing is sent (the answer never changes). */
export const MAGIC_LINKS_PER_ADDRESS = 3;
export const MAGIC_LINK_CAP_WINDOW_MS = 15 * 60_000;

const linkInvalid = () => new ApiError(400, 'link_invalid', 'This sign-in link has expired or has already been used. Ask for a new one.');

/**
 * Customer sign-in by magic link (plan 4.2). The link carries the token in the URL fragment, so it never reaches a
 * server log or a Referer; only a POST consumes it. The token is minted inside the mail send step (plan 4.6).
 */
@Injectable()
export class CustomerAuthService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(MailTemplateRegistry) private readonly templates: MailTemplateRegistry,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    if (this.templates.get(MAGIC_LINK_TEMPLATE.key, MAGIC_LINK_TEMPLATE.version)) return;
    this.templates.register({ ...MAGIC_LINK_TEMPLATE, render: (ctx) => this.renderMagicLink(ctx) });
  }

  /** Same work and same answer whether or not the address has an account (T2). */
  async requestLink(email: string, requestId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Task 8.5 (S-07): counted in the database, so neither a restart nor a flood of other addresses resets the cap.
      if (!(await this.mail.withinAddressCap(tx, { to: email, templateKey: MAGIC_LINK_TEMPLATE.key, max: MAGIC_LINKS_PER_ADDRESS, windowMs: MAGIC_LINK_CAP_WINDOW_MS }))) return;
      const user = await tx.user.findUnique({ where: { kind_email: { kind: 'customer', email } }, select: { id: true } });
      const token = await tx.loginToken.create({
        data: { purpose: 'magic_link', email, userId: user?.id ?? null, tokenHash: null, expiresAt: new Date(Date.now() + MAGIC_LINK_MS) },
        select: { id: true },
      });
      await this.mail.enqueue({
        to: email, templateKey: MAGIC_LINK_TEMPLATE.key, templateVersion: MAGIC_LINK_TEMPLATE.version, locale: 'en-AU',
        dedupeKey: `auth:magic_link:${token.id}`, relatedEntityType: 'LoginToken', relatedEntityId: token.id,
      }, tx);
      // G4: identifiers and codes only; the address never reaches the audit tables.
      await this.audit.record(tx, {
        actor: { type: 'system', id: null, requestId: requestId ?? null }, action: 'auth.magicLink.requested', entityType: 'LoginToken', entityId: token.id,
        context: { purpose: 'magic_link', knownAccount: !!user },
      });
    });
  }

  /** Runs in the send step's transaction: a retry mints a new token and the previous one stops working. */
  private async renderMagicLink(ctx: RenderContext) {
    const id = ctx.email.relatedEntityId;
    if (!id) throw new AppError('magic_link_missing_token', 'The email is not linked to a sign-in token');
    const token = newToken();
    const minted = await ctx.tx.loginToken.updateMany({
      where: { id, purpose: 'magic_link', consumedAt: null },
      data: { tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + MAGIC_LINK_MS) },
    });
    if (minted.count !== 1) throw new AppError('magic_link_superseded', 'The sign-in token was already used');
    const url = `${new URL(this.config.WEB_ORIGIN).origin}/account/sign-in/verify#token=${token}`;
    const name = brand.name;
    return {
      subject: `Your ${name} sign-in link`,
      text: `Hi,\n\nUse this link to sign in to ${name}:\n\n${url}\n\nIt works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.\n\n${name}`,
    };
  }

  private async liveToken(token: string) {
    if (!looksLikeToken(token)) throw linkInvalid();
    const row = await this.prisma.loginToken.findUnique({ where: { tokenHash: tokenHash(token) }, select: { id: true, purpose: true, email: true, consumedAt: true, expiresAt: true } });
    if (!row || row.purpose !== 'magic_link' || row.consumedAt || row.expiresAt <= new Date()) throw linkInvalid();
    return row;
  }

  /** M4: lets the page say "Continue as …" without consuming the link. */
  async inspect(token: string): Promise<{ email: string }> {
    return { email: (await this.liveToken(token)).email };
  }

  /** Consumes the link with a compare-and-set and signs the customer in, creating their user on first sign-in. */
  async verify(token: string, meta: RequestMeta, requestId?: string) {
    if (!looksLikeToken(token)) throw linkInvalid();
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const [consumed] = await tx.$queryRaw<Array<{ id: string; email: string }>>`
        UPDATE login_tokens SET "consumedAt" = ${now}::timestamptz
        WHERE "tokenHash" = ${tokenHash(token)} AND purpose = 'magic_link' AND "consumedAt" IS NULL AND "expiresAt" > ${now}::timestamptz
        RETURNING id, email::text AS email`;
      if (!consumed) throw linkInvalid();
      // Two first sign-ins at once create one user (ON CONFLICT on kind + email).
      const [user] = await tx.$queryRaw<Array<{ id: string; status: string; inserted: boolean }>>`
        INSERT INTO users (id, kind, email, "emailVerifiedAt", "updatedAt")
        VALUES (gen_random_uuid(), 'customer', ${consumed.email}, ${now}::timestamptz, ${now}::timestamptz)
        ON CONFLICT (kind, email) DO UPDATE SET "emailVerifiedAt" = COALESCE(users."emailVerifiedAt", EXCLUDED."emailVerifiedAt")
        RETURNING id, status::text AS status, (xmax = 0) AS inserted`;
      if (!user || user.status !== 'active') throw linkInvalid();
      await tx.loginToken.update({ where: { id: consumed.id }, data: { userId: user.id } });
      const session = await this.sessions.create(tx, { userId: user.id, kind: 'customer', mfaVerifiedAt: null, meta, now });
      const actor = { type: 'customer' as const, id: user.id, sessionId: session.sessionId, requestId: requestId ?? null };
      if (user.inserted) {
        await this.audit.record(tx, { actor, action: 'auth.customer.created', entityType: 'User', entityId: user.id, after: { kind: 'customer', email: consumed.email } });
      }
      await this.audit.record(tx, { actor, action: 'auth.customer.signedIn', entityType: 'User', entityId: user.id, context: { method: 'magic_link' } });
      await this.outbox.publish(tx, { type: 'auth.user.logged_in', aggregateType: 'User', aggregateId: user.id, actorType: 'customer', actorId: user.id, payload: { userId: user.id, sessionId: session.sessionId } });
      return session;
    });
  }

  async signOut(auth: { userId: string; sessionId: string }, requestId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revoke(tx, auth.sessionId, 'sign_out');
      await this.audit.record(tx, { actor: { type: 'customer', id: auth.userId, sessionId: auth.sessionId, requestId: requestId ?? null }, action: 'auth.customer.signedOut', entityType: 'Session', entityId: auth.sessionId });
    });
  }
}
