// The card page's side of a card session (plan docs/plans/4.4-au-card-gateway.md, sections 6.3, 6.4 and 10.1): what the
// page shows, the one submission of a card token, and the way back from 3-D Secure. The amount is the session's (set by
// the core from the payment plan); the page computes nothing and sends nothing but the gateway's single-use token.
import { Inject, Injectable } from '@nestjs/common';
import type { CardSessionFailure, CardSessionView, CardSubmitResult } from '@mt/shared';
import { CARD_SESSION_FAILURES, CARD_SESSION_REF_PATTERN } from '@mt/shared';
import { WindowLimiter } from '../../../../platform/auth/attempt-limiter';
import { rateLimitKey } from '../../../../platform/http/client-ip-watch';
import type { AppConfig } from '../../../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../../../platform/database/prisma.service';
import { AuditService } from '../../../../platform/audit/audit.service';
import type { AuditActor } from '../../../../platform/audit/audit.service';
import { runTransaction } from '../../../../platform/database/transaction';
import { conflict, notFound, tooManyRequests } from '../../../../platform/http/api-error';
import { readBookingForPayments } from '../../../bookings';
import { PaymentAttemptsService } from '../attempts.service';
import { lockPayment } from '../attempt-state';
import { ProviderGateway } from '../gateway';
import { PAYMENT_TX_OPTIONS } from '../payable-states';
import { CARD_DECLINE_CODES, ProviderError } from '../provider';
import { bookingUnderPaymentReview, underReview } from '../refunds.service';
import { CardSessionProvider } from './provider';
import type { CardPayer } from './provider';
import type { CardSession } from './store';

/** Submissions and 3-D Secure returns per IP over this window (plan 4.4, section 10.1; limits in the configuration). */
const SUBMIT_WINDOW_MS = 10 * 60_000;
/** Declines on one account per hour before a task for Oscar (nothing is blocked: section 10.1; limit in the configuration). */
const DECLINE_WINDOW_MS = 3_600_000;

/** An IPv4 address as Node reports it on a dual-stack socket (`::ffff:a.b.c.d`) becomes plain a.b.c.d (review m6). */
export const normaliseIp = (ip: string | undefined): string | undefined => {
  if (!ip) return undefined;
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : ip;
};

const isFailure = (v: string | null): v is CardSessionFailure => v !== null && (CARD_SESSION_FAILURES as readonly string[]).includes(v);

@Injectable()
export class CardSessionsService {
  private readonly submitsPerIp: WindowLimiter;
  private readonly authenticatedPerIp: WindowLimiter;
  private readonly declines: WindowLimiter;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentAttemptsService) private readonly attempts: PaymentAttemptsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.submitsPerIp = new WindowLimiter(config.CARD_SUBMITS_PER_10_MIN_PER_IP, SUBMIT_WINDOW_MS);
    this.authenticatedPerIp = new WindowLimiter(config.CARD_AUTHENTICATED_PER_10_MIN_PER_IP, SUBMIT_WINDOW_MS);
    this.declines = new WindowLimiter(config.CARD_DECLINES_PER_HOUR_PER_ACCOUNT, DECLINE_WINDOW_MS);
  }

  /** The session of a reference, in this environment's mode, with the card-session provider of its account; else 404. */
  private async locate(ref: string): Promise<{ accountId: string; provider: CardSessionProvider; returnUrl: string }> {
    if (!CARD_SESSION_REF_PATTERN.test(ref)) throw notFound();
    const row = await this.prisma.cardSession.findUnique({ where: { ref }, select: { providerAccountId: true, mode: true, returnUrl: true, providerAccount: { select: { adapterKey: true } } } });
    if (!row || row.mode !== this.gateway.mode) throw notFound();
    const provider = this.gateway.registry.get(row.providerAccount.adapterKey);
    if (!(provider instanceof CardSessionProvider)) throw notFound();
    return { accountId: row.providerAccountId, provider, returnUrl: row.returnUrl };
  }

  /** What the card page shows (plan 4.4, section 10.1): the amount, and the publishable key only while open and active. */
  async view(ref: string): Promise<CardSessionView> {
    const { accountId, provider } = await this.locate(ref);
    const account = await this.prisma.providerAccount.findUniqueOrThrow({ where: { id: accountId }, select: { status: true } });
    // Reads only: a paused account still shows where the session stands, without the card fields.
    const page = await this.gateway.call(accountId, 'retrieve', async (p, ctx) => (p as CardSessionProvider).cardPage(ctx, ref)).catch((err: unknown) => {
      if (err instanceof ProviderError) return null;
      throw err;
    });
    const session = page?.session ?? (await provider.session(accountId, ref));
    if (!session) throw notFound();
    const status = session.status === 'open' ? 'open' : session.status === 'submitting' || session.status === 'authenticating' ? 'processing' : 'finished';
    const view: CardSessionView = { status, amountMinor: session.amountMinor.toString(), currency: session.currency };
    if (status === 'open' && account.status === 'active' && page?.publishableKey && provider.manifest.cardFields) {
      view.card = { publishableKey: page.publishableKey, sandbox: session.mode === 'test', scriptUrl: provider.manifest.cardFields.scriptUrl };
    }
    if (session.status === 'failed' && isFailure(session.failureCode)) view.failed = session.failureCode;
    if (status === 'finished') view.returnUrl = session.returnUrl;
    return view;
  }

  /**
   * The one card submission of a session (plan 4.4, section 6.3): the attempt is live and this session's, the booking can
   * pay and is not under review; then the gateway is called outside any transaction, through the wrapper's `create`
   * rules (active account, mode, never live unless verified).
   */
  async submit(ref: string, cardToken: string, rawIp: string | undefined, flow: 'after_charge' | 'before_charge' = 'after_charge'): Promise<CardSubmitResult> {
    const ipAddress = normaliseIp(rawIp);
    if (!ipAddress || !this.submitsPerIp.allow(`card-submit:ip:${rateLimitKey(rawIp)}`)) throw tooManyRequests(600);
    const { accountId, provider } = await this.locate(ref);
    // Task 9.1: each card page posts only to its own gateway's flow.
    if (provider.gateway.authentication !== flow) throw notFound();
    const session = await provider.session(accountId, ref);
    if (!session) throw notFound();
    const payer = await this.checkOpen(session, accountId, ref, ipAddress, provider.beforeCharge);
    const result = await this.gateway.call(accountId, 'create', (p, ctx) => (p as CardSessionProvider).submitCard(ctx, ref, cardToken, payer));
    return this.answer(accountId, result);
  }

  /**
   * Task 9.1 (plan docs/plans/9.1-eway.md, section 6.4): the customer finished eWAY's 3-D Secure challenge; the one
   * charge is sent now, under the same checks as a submission (live attempt, payable booking, the wrapper's `create`
   * rules). Only the access code of this session and the card it authenticated are accepted.
   */
  async authorise(ref: string, accessCode: string, cardToken: string, rawIp: string | undefined): Promise<CardSubmitResult> {
    const ipAddress = normaliseIp(rawIp);
    if (!ipAddress || !this.authenticatedPerIp.allow(`card-authorise:ip:${rateLimitKey(rawIp)}`)) throw tooManyRequests(600);
    const { accountId, provider } = await this.locate(ref);
    if (!provider.beforeCharge) throw notFound();
    const session = await provider.session(accountId, ref);
    if (!session) throw notFound();
    await this.checkOpen(session, accountId, ref, ipAddress, false);
    const result = await this.gateway.call(accountId, 'create', (p, ctx) => (p as CardSessionProvider).authoriseCard(ctx, ref, accessCode, cardToken, ipAddress));
    return this.answer(accountId, result);
  }

  private async answer(accountId: string, result: Awaited<ReturnType<CardSessionProvider['submitCard']>>): Promise<CardSubmitResult> {
    await this.noteDecline(accountId, result.session);
    if (result.next.kind === 'not_open') throw conflict('card_session_not_open', 'This payment is no longer open. Start again from your booking.');
    if (result.next.kind === 'wait') return { next: 'wait' };
    if (result.next.kind === 'authenticate') return { next: 'authenticate', accessCode: result.next.authRef };
    return { next: 'redirect', url: result.next.url };
  }

  /**
   * The attempt is live and this session's, the booking can pay and is not under review (plan 4.4, 6.3). The payer is
   * the payment's own (plan 9.1, 20 m9): email always; name and phone when the gateway's 3-D Secure needs them.
   */
  private async checkOpen(session: CardSession, accountId: string, ref: string, ipAddress: string, needsNameAndPhone: boolean): Promise<CardPayer> {
    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: session.bookingId }, true);
      if (!b) throw notFound();
      const p = await lockPayment(tx, b, session.paymentId);
      if (!p || p.status !== 'requires_action' || p.providerPaymentRef !== ref || p.providerAccountId !== accountId) throw conflict('card_session_not_open', 'This payment is no longer open. Start again from your booking.');
      const [{ at }] = (await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`) as [{ at: Date }];
      this.attempts.assertPayable(b, at);
      if (await bookingUnderPaymentReview(tx, b.id, this.gateway.mode)) throw underReview();
      const [payer] = await tx.$queryRaw<Array<{ email: string | null; givenName: string | null; familyName: string | null; phone: string | null }>>`
        SELECT c.email, c."givenName", c."familyName", c.phone FROM payments p JOIN customers c ON c.id = p."payerCustomerId" WHERE p.id = ${session.paymentId}::uuid`;
      if (!payer?.email) throw conflict('card_session_not_open', 'This payment is no longer open. Start again from your booking.');
      if (!needsNameAndPhone) return { email: payer.email, ipAddress };
      if (!payer.phone || !payer.givenName || !payer.familyName) throw conflict('card_session_phone_required', 'Add a phone number to your account to pay by card, then try again.');
      return { email: payer.email, ipAddress, givenName: payer.givenName, familyName: payer.familyName, phone: payer.phone };
    }, PAYMENT_TX_OPTIONS);
  }

  /** The way back from 3-D Secure (plan 4.4, section 6.4): always to the session's own return page. Reads only. */
  async authenticated(ref: string, sessionToken: string | undefined, ipAddress: string | undefined): Promise<string> {
    let located: Awaited<ReturnType<CardSessionsService['locate']>>;
    try {
      located = await this.locate(ref);
    } catch {
      return `${new URL(this.config.WEB_ORIGIN).origin}/`;
    }
    const allowed = !!ipAddress && this.authenticatedPerIp.allow(`card-authenticated:ip:${rateLimitKey(ipAddress)}`);
    if (allowed && typeof sessionToken === 'string' && /^se_[A-Za-z0-9_-]{10,64}$/.test(sessionToken)) {
      try {
        const s = await this.gateway.call(located.accountId, 'retrieve', (p, ctx) => (p as CardSessionProvider).finishAuthentication(ctx, ref, sessionToken));
        if (s) await this.noteDecline(located.accountId, s);
      } catch {
        // The return page asks again (sync); the sweep reads the charge.
      }
    }
    return located.returnUrl;
  }

  /**
   * Task 9.1 (plan docs/plans/9.1-eway.md, 20 m10): staff bind a session the gateway cannot search (its reference is on
   * several transactions) to the transaction they found at the gateway. The provider checks the transaction carries
   * this session's reference, amount and currency; the bind is audited. The core records it on its next read.
   */
  async bindByStaff(actor: AuditActor, ref: string, transactionId: string): Promise<{ status: string }> {
    if (!/^[0-9]{1,19}$/.test(transactionId)) throw conflict('card_session_bind_invalid', 'That is not a transaction number.');
    const { accountId, provider } = await this.locate(ref);
    // Only eWAY's search can be refused as not unique (plan 9.1, 20 m10).
    if (!provider.beforeCharge) throw conflict('card_session_bind_refused', 'That transaction does not belong to this card session, or the session is already resolved.');
    let s: CardSession;
    try {
      s = await this.gateway.call(accountId, 'retrieve', (p, ctx) => (p as CardSessionProvider).bindByStaff(ctx, ref, `ewt_${transactionId}`));
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) throw conflict('card_session_bind_refused', 'That transaction does not belong to this card session, or the session is already resolved.');
      throw err;
    }
    await runTransaction(this.prisma, (tx) => this.audit.record(tx, {
      actor, action: 'payments.cardSession.bound', entityType: 'CardSession', entityId: s.id, context: { chargeRef: s.chargeRef, status: s.status },
    }));
    return { status: s.status };
  }

  /** Counts declines per account; past the threshold, one task (nothing is blocked). */
  private async noteDecline(accountId: string, s: CardSession): Promise<void> {
    if (s.status !== 'failed' || !(CARD_DECLINE_CODES as readonly string[]).includes(s.failureCode ?? '')) return;
    if (this.declines.allow(`card-declines:${accountId}`)) return;
    const hour = new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
    const provider = await this.prisma.providerAccount.findUnique({ where: { id: accountId }, select: { adapterKey: true } });
    const p = provider ? this.gateway.registry.get(provider.adapterKey) : undefined;
    if (p instanceof CardSessionProvider) await p.openTask('declines_spike', accountId, `${accountId}:${hour}`).catch(() => undefined);
  }
}
