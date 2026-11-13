import { Inject, Injectable } from '@nestjs/common';
import { MARKETING_WORDING_KEY } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { AuditActor } from '../../platform/audit/audit.service';
import { AuditService, SYSTEM_ACTOR } from '../../platform/audit/audit.service';
import type { AppConfig } from '../../platform/config/config';
import { emailHash, safeEqualHex, unsubscribeToken } from '../../platform/crypto/hmac';
import { APP_CONFIG, PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { notFound, unprocessable } from '../../platform/http/api-error';
import { MailService } from '../../platform/mail/mail.service';

type Tx = Prisma.TransactionClient;
type Source = 'account' | 'unsubscribe_link' | 'erasure';

export interface ConsentState {
  granted: boolean;
  recordedAt: Date | null;
}

const REF = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/;

/**
 * Marketing consent (task 5.5, plan section 7). One append-only row per change; the current state is the latest row for
 * the customer or for the address hash, so consent given before a customer record existed carries over. Every change to
 * one address runs under a transaction-scoped advisory lock on its hash, so the account page and an unsubscribe link
 * racing on the same address cannot interleave (review point 11).
 */
@Injectable()
export class ConsentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  hashOf(email: string): string {
    return emailHash(this.config.EMAIL_HASH_KEY, email);
  }

  private async lockAddress(tx: Tx, hash: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`consent:${hash}`}, 0))`;
  }

  async current(db: Tx | PrismaService, who: { customerId: string | null; emailHash: string }): Promise<ConsentState> {
    const row = await db.consentRecord.findFirst({
      where: { purpose: 'marketing_email', OR: [...(who.customerId ? [{ customerId: who.customerId }] : []), { emailHash: who.emailHash }] },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      select: { granted: true, recordedAt: true },
    });
    return row ? { granted: row.granted, recordedAt: row.recordedAt } : { granted: false, recordedAt: null };
  }

  /**
   * Records a change if the state changes (a repeated click writes nothing). Withdrawal adds a `marketing` suppression
   * (never downgrading an `all` one); giving consent lifts only an unsubscribe. Caller holds the customer lock, if any.
   */
  async change(tx: Tx, who: { customerId: string | null; email: string }, granted: boolean, source: Source, actor: AuditActor): Promise<boolean> {
    const hash = this.hashOf(who.email);
    await this.lockAddress(tx, hash);
    const now = await this.current(tx, { customerId: who.customerId, emailHash: hash });
    const changed = now.granted !== granted || (now.recordedAt === null && !granted && source !== 'account');
    if (granted) await this.mail.liftMarketingUnsubscribe(who.email, tx);
    else await this.mail.addSuppression(who.email, 'unsubscribed', 'marketing', tx);
    if (!changed) return false;
    const row = await tx.consentRecord.create({
      data: { customerId: who.customerId, emailHash: hash, purpose: 'marketing_email', granted, source, wordingKey: MARKETING_WORDING_KEY },
      select: { id: true },
    });
    await this.audit.record(tx, {
      actor, action: 'privacy.consent.changed', entityType: who.customerId ? 'Customer' : 'ConsentRecord', entityId: who.customerId ?? row.id,
      context: { purpose: 'marketing_email', granted, source },
    });
    return true;
  }

  /** The wording the person saw must be the one the server shows now (review point 15). */
  assertWording(wordingKey: string): void {
    if (wordingKey !== MARKETING_WORDING_KEY) throw unprocessable('consent_wording_out_of_date', 'Reload the page and try again');
  }

  /**
   * RFC 8058 one-click unsubscribe from a marketing email (`<outboundEmailId>.<hmac>`). A wrong HMAC and an unknown id
   * are the same 404. An email whose address was erased is a no-op. Idempotent: the second click writes nothing.
   */
  async unsubscribe(ref: string): Promise<void> {
    const m = REF.exec(ref);
    if (!m || !safeEqualHex(m[2]!, unsubscribeToken(this.config.EMAIL_HASH_KEY, m[1]!))) throw notFound('unsubscribe_link_invalid', 'This link is not valid');
    await runTransaction(this.prisma, async (tx) => {
      const email = await tx.outboundEmail.findUnique({ where: { id: m[1]! }, select: { to: true, customerId: true } });
      if (!email) throw notFound('unsubscribe_link_invalid', 'This link is not valid');
      if (/^erased\+.*@invalid$/.test(email.to)) return;
      let customerId: string | null = null;
      if (email.customerId) {
        // Customer first (plan 0.1, 6.3), then the address lock inside change().
        const [c] = await tx.$queryRaw<Array<{ id: string; erased: boolean }>>`
          SELECT id::text AS id, ("anonymisedAt" IS NOT NULL OR "deletedAt" IS NOT NULL) AS erased FROM customers WHERE id = ${email.customerId}::uuid FOR UPDATE`;
        if (c && !c.erased) customerId = c.id;
      }
      await this.change(tx, { customerId, email: email.to }, false, 'unsubscribe_link', SYSTEM_ACTOR);
    });
  }

  /** History for the panel: what changed, how and when; never the address or its hash. */
  async history(db: Tx | PrismaService, customerId: string, email: string) {
    return db.consentRecord.findMany({
      where: { purpose: 'marketing_email', OR: [{ customerId }, { emailHash: this.hashOf(email) }] },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      select: { granted: true, source: true, recordedAt: true },
    });
  }

  /**
   * Erasure (plan section 5, step 5): a last withdrawal for each address that ever had a consent record, with no
   * customer link, so the address stays opted out whoever signs up with it later until they opt in again.
   */
  async withdrawForErasure(tx: Tx, customerId: string, emails: readonly string[]): Promise<void> {
    for (const email of emails) {
      const hash = this.hashOf(email);
      await this.lockAddress(tx, hash);
      const any = await tx.consentRecord.findFirst({ where: { OR: [{ customerId }, { emailHash: hash }] }, select: { id: true } });
      if (!any) continue;
      await tx.consentRecord.create({ data: { customerId: null, emailHash: hash, purpose: 'marketing_email', granted: false, source: 'erasure', wordingKey: MARKETING_WORDING_KEY } });
    }
  }
}
