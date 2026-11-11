import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { AppConfig } from '../config/config';
import { emailHash, sha256Hex, unsubscribeToken } from '../crypto/hmac';
import { bossDb } from '../database/boss-db';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { AppError, formatSafeError, safeError } from '../errors/safe-error';
import { JobsService } from '../jobs/jobs.service';
import { QUEUES } from '../jobs/queues';
import { evaluateMailGuard, isLiveMail } from './mail-guard';
import { MAIL_SENDER, MailSender } from './mail-sender';
import { MailTemplateRegistry } from './templates';

export interface EnqueueMailInput {
  to: string;
  templateKey: string;
  templateVersion: number;
  locale: string;
  /** Derived from the fact that caused the email, such as booking:<id>:approved. One fact, one email. */
  dedupeKey: string;
  category?: 'transactional' | 'marketing';
  customerId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

export type SendOutcome = 'sent' | 'suppressed' | 'noop' | 'failed';
const MAX_ATTEMPTS = 5;

@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
    @Inject(MailTemplateRegistry) private readonly templates: MailTemplateRegistry,
  ) {
    const { warning } = isLiveMail(config);
    if (warning) this.logger.warn(warning);
  }

  /**
   * Records the email and queues the send, in the caller's transaction when one is given. Calling it twice for the
   * same dedupeKey creates one email. The job carries only the email id: the body is rendered at send time.
   */
  async enqueue(input: EnqueueMailInput, tx?: Prisma.TransactionClient): Promise<{ id: string; created: boolean }> {
    if (!tx) return this.prisma.$transaction((t) => this.enqueue(input, t));
    const existing = await tx.outboundEmail.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
    if (existing) return { id: existing.id, created: false };
    // ON CONFLICT keeps a concurrent duplicate from aborting the caller's transaction.
    const id = (await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO outbound_emails (id, "to", "templateKey", "templateVersion", locale, "dedupeKey", category, "customerId", "relatedEntityType", "relatedEntityId", "updatedAt")
      VALUES (gen_random_uuid(), ${input.to}, ${input.templateKey}, ${input.templateVersion}, ${input.locale}, ${input.dedupeKey},
        ${input.category ?? 'transactional'}::"MailCategory", ${input.customerId ?? null}::uuid, ${input.relatedEntityType ?? null}, ${input.relatedEntityId ?? null}::uuid, now())
      ON CONFLICT ("dedupeKey") DO NOTHING RETURNING id`)[0]?.id;
    if (!id) {
      const winner = await tx.outboundEmail.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
      return { id: winner.id, created: false };
    }
    await this.jobs.send(QUEUES.mailSend, { outboundEmailId: id }, { db: bossDb(tx), singletonKey: id });
    return { id, created: true };
  }

  /**
   * The send step. The row is locked and only a `queued` email is processed, so a repeated job never sends twice.
   * Rendering happens inside this transaction: a one-time token minted by the template commits with the send, and
   * a retry mints a fresh one (the failed attempt's token rolled back with it).
   */
  async processSend(outboundEmailId: string): Promise<SendOutcome> {
    let attemptsBefore = 0;
    let started = false;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM outbound_emails WHERE id = ${outboundEmailId}::uuid AND status = 'queued' FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return 'noop';
        const email = await tx.outboundEmail.findUniqueOrThrow({ where: { id: outboundEmailId } });
        started = true;
        attemptsBefore = email.attempts;

        const guard = evaluateMailGuard(this.config, email.to);
        if (!guard.allowed) return this.suppress(tx, email.id, guard.reason ?? 'suppressed');
        if (email.category === 'marketing') {
          const hit = await tx.emailSuppression.findUnique({ where: { emailHash: emailHash(this.config.EMAIL_HASH_KEY, email.to) } });
          if (hit) return this.suppress(tx, email.id, 'recipient_suppressed');
        }

        const template = this.templates.get(email.templateKey, email.templateVersion);
        if (!template) throw new AppError('mail_template_not_registered', 'No template is registered for this email');
        const token = unsubscribeToken(this.config.EMAIL_HASH_KEY, email.id);
        const rendered = await template.render({
          tx, unsubscribeToken: token,
          email: { id: email.id, to: email.to, locale: email.locale, customerId: email.customerId, relatedEntityType: email.relatedEntityType, relatedEntityId: email.relatedEntityId },
        });
        const { providerMessageId } = await this.sender.send({
          from: this.config.MAIL_FROM, to: email.to, subject: rendered.subject, text: rendered.text, html: rendered.html,
          ...(email.category === 'marketing' ? { headers: { 'List-Unsubscribe': `<${this.config.API_BASE_URL}/unsubscribe/${email.id}.${token}>` } } : {}),
        });
        await tx.outboundEmail.update({
          where: { id: email.id },
          data: {
            status: 'sent', sentAt: new Date(), providerMessageId, attempts: { increment: 1 }, error: null,
            subject: rendered.subject, bodySha256: sha256Hex(`${rendered.text}\n${rendered.html ?? ''}`),
          },
        });
        return 'sent';
      });
    } catch (err) {
      if (!started) throw err;
      const info = safeError(err);
      const attempts = attemptsBefore + 1;
      const failed = attempts >= MAX_ATTEMPTS || (err instanceof AppError && err.code === 'mail_template_not_registered');
      await this.prisma.outboundEmail.updateMany({
        where: { id: outboundEmailId, status: 'queued' },
        data: { attempts, error: formatSafeError(info), ...(failed ? { status: 'failed' as const } : {}) },
      });
      this.logger.warn(`email ${outboundEmailId} failed: ${info.code}`);
      if (failed) return 'failed';
      throw err;
    }
  }

  private async suppress(tx: Prisma.TransactionClient, id: string, reason: string): Promise<SendOutcome> {
    await tx.outboundEmail.update({ where: { id }, data: { status: 'suppressed', error: reason } });
    return 'suppressed';
  }

  /** Records a bounce, unsubscribe or complaint. Only an HMAC of the address is kept. */
  async addSuppression(email: string, reason: 'unsubscribed' | 'bounced' | 'complaint', scope: 'marketing' | 'all'): Promise<void> {
    const hash = emailHash(this.config.EMAIL_HASH_KEY, email);
    await this.prisma.emailSuppression.upsert({ where: { emailHash: hash }, create: { emailHash: hash, reason, scope }, update: { reason, scope } });
  }
}
