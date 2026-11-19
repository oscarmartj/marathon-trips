import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import type { AppConfig } from '../../../platform/config/config';
import { bossDb } from '../../../platform/database/boss-db';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { hmacHex, sha256Hex } from '../../../platform/crypto/hmac';
import { AppError, safeError } from '../../../platform/errors/safe-error';
import { ApiError, notFound } from '../../../platform/http/api-error';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { readBookingForPayments } from '../../bookings';
import { PaymentStateMachine, lockPayment } from './attempt-state';
import { CoverageFailedError } from './coverage.service';
import { PAYMENT_TX_OPTIONS, PaymentAttemptsService } from './attempts.service';
import { ACCOUNT_PUBLIC_SELECT, ProviderGateway } from './gateway';
import type { AccountForCall } from './gateway';
import type { ProviderDispute, ProviderPayment, ProviderRefund } from './provider';
import { PaymentDisputesService } from './disputes.service';
import { PaymentRefundStateMachine, lockRefund, refundEventOf } from './refunds.service';
import type { RefundEvent } from './refunds.service';

export const WEBHOOK_PATH_PREFIX = '/payments/webhooks';
export const WEBHOOK_MAX_BYTES = 256 * 1024;
/** Path tokens are 32 random bytes in base64url. */
const PATH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Headers kept with an event or a rejection; signature headers are kept by name only. */
const KEPT_HEADERS = ['content-type', 'content-length', 'user-agent'];

export const webhookPathTokenHash = (key: string, token: string): string => hmacHex(key, `payments.webhook_path:${token}`);

export type ProcessOutcome = 'processed' | 'ignored' | 'skipped';

/**
 * Incoming gateway webhooks (plan 3.1, section 6). Receiving: account by the hash of the path token, signature checked
 * with that account's secret, the raw event stored once per gateway event id and a job queued in the same transaction.
 * Processing: the payment is matched first by our id (from the same account), then by the gateway reference, then the
 * state machine moves it forward. Unknown paths and oversized bodies never reach the database.
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger('PaymentWebhooks');
  readonly counters = { unknownAccount: 0 };

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentStateMachine) private readonly machine: PaymentStateMachine,
    @Inject(PaymentAttemptsService) private readonly attempts: PaymentAttemptsService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PaymentRefundStateMachine) private readonly refunds: PaymentRefundStateMachine,
    @Inject(PaymentDisputesService) private readonly disputes: PaymentDisputesService,
  ) {}

  sanitiseHeaders(headers: Record<string, string | string[] | undefined>, signatureHeaders: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of KEPT_HEADERS) {
      const v = headers[k];
      if (typeof v === 'string') out[k] = v.slice(0, 200);
    }
    for (const k of signatureHeaders) if (headers[k] !== undefined) out[k] = '[present]';
    return out;
  }

  async receive(pathToken: string, rawBody: unknown, headers: Record<string, string | string[] | undefined>, now: Date = new Date()): Promise<{ received: true; duplicate: boolean }> {
    if (!Buffer.isBuffer(rawBody)) throw new ApiError(400, 'bad_request', 'The request could not be read');
    const account = PATH_TOKEN.test(pathToken)
      ? await this.prisma.providerAccount.findUnique({ where: { webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, pathToken) }, select: ACCOUNT_PUBLIC_SELECT })
      : null;
    if (!account) {
      // No row for an unknown path: a counter and a code only (plan 3.1, section 14, point 5).
      this.counters.unknownAccount++;
      this.logger.warn('payment webhook: unknown_account');
      throw notFound();
    }
    return this.receiveForAccount(account, rawBody, headers, now);
  }

  /**
   * The simulator's hosted checkout delivers its webhook here, in the process (plan 3.6, section 3.2): the same path as
   * an HTTP delivery once the account is known by its path token. Signature, raw event, duplicate key and job as above.
   */
  async receiveForAccountId(accountId: string, rawBody: Buffer, headers: Record<string, string>, now: Date = new Date()): Promise<{ received: true; duplicate: boolean }> {
    const account = await this.prisma.providerAccount.findUnique({ where: { id: accountId }, select: ACCOUNT_PUBLIC_SELECT });
    if (!account) throw notFound();
    return this.receiveForAccount(account, rawBody, headers, now);
  }

  private async receiveForAccount(account: AccountForCall, rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): Promise<{ received: true; duplicate: boolean }> {
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') flat[k.toLowerCase()] = v;
    const signatureHeaders = this.gateway.signatureHeaders(account.adapterKey);
    const verdict = await this.gateway.verifyWebhook(account, rawBody, flat, now);
    if (!verdict.ok) {
      await this.prisma.webhookRejection.create({
        data: {
          providerAccountId: account.id, reason: verdict.code, bodySha256: sha256Hex(rawBody), sizeBytes: rawBody.length,
          claimedEventId: verdict.claimedEventId ?? null, headers: this.sanitiseHeaders(headers, signatureHeaders),
        },
      });
      throw new ApiError(400, 'webhook_rejected', 'The webhook was rejected');
    }
    const event = verdict.event;
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.webhookEvent.createMany({
        data: [{ providerAccountId: account.id, providerEventId: event.providerEventId, type: event.type, rawBody: new Uint8Array(rawBody), headers: this.sanitiseHeaders(headers, signatureHeaders) }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return { received: true as const, duplicate: true };
      const row = await tx.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: account.id, providerEventId: event.providerEventId } }, select: { id: true } });
      await this.jobs.send(QUEUES.paymentsWebhooks, { webhookEventId: row.id }, { db: bossDb(tx), singletonKey: `webhook:${row.id}` });
      return { received: true as const, duplicate: false };
    });
  }

  /** Processes one stored event; safe to run twice. A failure is recorded with its code and rethrown for the job to retry. */
  async process(webhookEventId: string): Promise<ProcessOutcome> {
    try {
      return await this.processOnce(webhookEventId);
    } catch (err) {
      await this.prisma.webhookEvent.updateMany({ where: { id: webhookEventId, status: { in: ['received', 'failed'] } }, data: { status: 'failed', attempts: { increment: 1 }, errorCode: safeError(err).code.slice(0, 64) } });
      // The coverage rule failed: the payment is not recorded, and Oscar gets a task now (plan 3.2, section 11.8).
      if (err instanceof CoverageFailedError) await this.attempts.afterCoverageFailure(err);
      throw err;
    }
  }

  private async processOnce(webhookEventId: string): Promise<ProcessOutcome> {
    const ev = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId }, select: { id: true, providerAccountId: true, providerEventId: true, rawBody: true, status: true, providerAccount: { select: { adapterKey: true } } } });
    if (!ev) throw notFound();
    if (ev.status !== 'received' && ev.status !== 'failed') return 'skipped';
    const provider = this.gateway.registry.get(ev.providerAccount.adapterKey);
    const parsed = ev.rawBody && provider ? provider.parseEvent(Buffer.from(ev.rawBody)) : null;
    if (!parsed) return this.ignore(ev.id, ev.rawBody ? 'malformed' : 'body_purged');
    if (parsed.kind === 'refund' && parsed.refund) return this.processRefund(ev, parsed.refund);
    if (parsed.kind === 'dispute' && parsed.dispute) return this.processDispute(ev, parsed.dispute);
    if (parsed.kind !== 'payment' || !parsed.payment) return this.ignore(ev.id, 'unsupported');
    const remote = parsed.payment;

    // Match first by our id, only among this account's payments; then by the gateway reference (plan 0.1, P5).
    const byId = remote.ourPaymentId && UUID.test(remote.ourPaymentId)
      ? await this.prisma.payment.findFirst({ where: { id: remote.ourPaymentId, providerAccountId: ev.providerAccountId }, select: { id: true, bookingId: true } })
      : null;
    const match = byId ?? await this.prisma.payment.findFirst({ where: { providerAccountId: ev.providerAccountId, providerPaymentRef: remote.ref }, select: { id: true, bookingId: true } });
    if (!match) {
      return runTransaction(this.prisma, async (tx) => {
        await this.tasks.createSystemIn(tx, {
          title: 'Payment webhook for an unknown payment',
          description: 'A payment gateway sent an event for a payment we cannot match. If money came in, register it against the right booking.',
          entityType: 'WebhookEvent', entityId: ev.id, sourceRef: `payments:unknown_event:${ev.id}`,
        });
        return this.ignoreIn(tx, ev.id, 'unknown_payment');
      });
    }

    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: match.bookingId }, true);
      if (!b) throw notFound();
      const p = await lockPayment(tx, b, match.id);
      if (!p) throw notFound();
      const current = await tx.webhookEvent.findUniqueOrThrow({ where: { id: ev.id }, select: { status: true } });
      if (current.status !== 'received' && current.status !== 'failed') return 'skipped' as const;
      // Matched to an erased customer's booking (task 5.5, review point 9): the raw body can quote the payer, so it is
      // not kept; the event's type, status and links are enough as a record, and the parsed event is already in memory.
      const [owner] = await tx.$queryRaw<Array<{ erased: boolean }>>`SELECT ("anonymisedAt" IS NOT NULL) AS erased FROM customers WHERE id = ${b.customerId}::uuid`;
      await tx.webhookEvent.update({ where: { id: ev.id }, data: { bookingId: b.id, paymentId: p.id, ...(owner?.erased ? { rawBody: null } : {}) } });
      if (p.providerPaymentRef !== null && p.providerPaymentRef !== remote.ref) {
        await this.attempts.mismatchTask(tx, p, b.reference);
        return this.ignoreIn(tx, ev.id, 'reference_mismatch');
      }
      if (remote.amount.amountMinor !== p.amountMinor || remote.amount.currency !== p.currency) {
        await this.attempts.mismatchTask(tx, p, b.reference);
        return this.ignoreIn(tx, ev.id, 'amount_or_currency_mismatch');
      }
      await this.machine.setReference(tx, p, remote.ref);
      await this.machine.apply(tx, b, p, remote.status, { source: 'webhook', failureCode: remote.failureCode });
      await tx.webhookEvent.update({ where: { id: ev.id }, data: { status: 'processed', processedAt: new Date(), attempts: { increment: 1 }, errorCode: null } });
      // A task opened while it kept failing is closed now that it went through (review round 2, point 3a).
      await this.tasks.closeSystemIn(tx, `payments:webhook_failed:${ev.id}`);
      return 'processed' as const;
    }, PAYMENT_TX_OPTIONS);
  }

  /**
   * A refund event (plan 3.3, sections 3.3 and 12.6). Outside any transaction, through the account that received it:
   * the payment it refunds (the gateway's word, also used to catch up a payment we have not seen succeed), and the real
   * state of a refund said to have failed and of this payment's refunds still open locally. A gateway error leaves the
   * event failed, to be retried. Then booking, payment and refund are locked in that order and the state machine runs.
   */
  private async processRefund(ev: { id: string; providerAccountId: string }, said: ProviderRefund): Promise<ProcessOutcome> {
    const accountId = ev.providerAccountId;
    const remotePayment = await this.gateway.call(accountId, 'retrieve', (provider, ctx) => provider.retrievePayment(ctx, { ref: said.paymentRef }));
    let remote = said;
    if (said.status === 'failed' || said.status === 'cancelled') {
      // A failure is believed only when the gateway confirms it (plan 0.1, 6.2): if it does not know the refund, the event
      // stays failed and is retried (fail closed), never applied on its own word.
      const confirmed = await this.gateway.call(accountId, 'retrieve', (provider, ctx) => provider.retrieveRefund(ctx, { ref: said.ref }));
      if (!confirmed) throw new AppError('refund_not_confirmed_by_gateway', 'The gateway does not confirm this refund');
      remote = confirmed;
    }
    const match = remotePayment ? await this.matchPayment(accountId, remotePayment) : null;
    if (!match || !remotePayment) return this.unknownPayment(ev.id);
    // Refunds of this payment still open here: their real state first, so a stale one never blocks a real refund.
    const open = await this.prisma.refund.findMany({ where: { paymentId: match.id, status: { in: ['requested', 'pending'] }, providerRefundRef: { not: null }, NOT: { providerRefundRef: said.ref } }, select: { id: true, providerRefundRef: true } });
    const refreshed: Array<{ id: string; event: RefundEvent; failureCode?: string }> = [];
    for (const o of open) {
      const r = await this.gateway.call(accountId, 'retrieve', (provider, ctx) => provider.retrieveRefund(ctx, { ref: o.providerRefundRef! }));
      if (r) refreshed.push({ id: o.id, event: refundEventOf(r.status), failureCode: r.failureCode });
    }

    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: match.bookingId }, true);
      if (!b) throw notFound();
      const p = await lockPayment(tx, b, match.id);
      if (!p) throw notFound();
      const current = await tx.webhookEvent.findUniqueOrThrow({ where: { id: ev.id }, select: { status: true } });
      if (current.status !== 'received' && current.status !== 'failed') return 'skipped' as const;
      const [owner] = await tx.$queryRaw<Array<{ erased: boolean }>>`SELECT ("anonymisedAt" IS NOT NULL) AS erased FROM customers WHERE id = ${b.customerId}::uuid`;
      await tx.webhookEvent.update({ where: { id: ev.id }, data: { bookingId: b.id, paymentId: p.id, ...(owner?.erased ? { rawBody: null } : {}) } });
      // The payment first (plan 0.1, P7): a refund of money we have not seen arrive catches the payment up.
      if (p.status !== 'succeeded' && remotePayment.status === 'succeeded') {
        if (remotePayment.amount.amountMinor !== p.amountMinor || remotePayment.amount.currency !== p.currency || (p.providerPaymentRef !== null && p.providerPaymentRef !== remotePayment.ref)) {
          await this.attempts.mismatchTask(tx, p, b.reference);
          return this.ignoreIn(tx, ev.id, 'amount_or_currency_mismatch');
        }
        await this.machine.setReference(tx, p, remotePayment.ref);
        await this.machine.apply(tx, b, p, 'succeeded', { source: 'webhook' });
      }
      if (p.status !== 'succeeded') return this.refusedRefund(tx, ev.id, b.reference, p.id, 'refund_of_uncollected_payment');
      // The refunded object must be this payment's own (as for payment events): another session carrying our id is not it.
      if (p.providerPaymentRef !== remotePayment.ref) {
        await this.attempts.mismatchTask(tx, p, b.reference);
        return this.ignoreIn(tx, ev.id, 'reference_mismatch');
      }
      for (const f of refreshed) {
        const r = await lockRefund(tx, p, f.id);
        if (r) await this.refunds.apply(tx, b, p, r, f.event, { source: 'webhook', failureCode: f.failureCode });
      }
      if (remote.amount.currency !== p.currency) return this.refusedRefund(tx, ev.id, b.reference, p.id, 'refund_currency_mismatch');

      const byOurs = remote.ourRefundId && UUID.test(remote.ourRefundId)
        ? await tx.refund.findFirst({ where: { id: remote.ourRefundId, providerAccountId: accountId }, select: { id: true } })
        : null;
      const known = byOurs ?? await tx.refund.findFirst({ where: { providerAccountId: accountId, providerRefundRef: remote.ref }, select: { id: true } });
      if (known) {
        const r = await lockRefund(tx, p, known.id);
        if (!r) throw notFound();
        if (r.amountMinor !== remote.amount.amountMinor) return this.refusedRefund(tx, ev.id, b.reference, p.id, 'refund_amount_mismatch');
        // An app refund matched by our id before the gateway answered us (task 4.5): its reference is filled in now.
        if (r.providerRefundRef !== null && r.providerRefundRef !== remote.ref) return this.refusedRefund(tx, ev.id, b.reference, p.id, 'refund_reference_mismatch');
        // Review of the code, H1: the gateway made an app refund we had failed: recorded, and Oscar checks it.
        if (await this.refunds.gatewayMovedFailedRefund(tx, b, p, r, remote, 'webhook')) return this.processedIn(tx, ev.id, r.id);
        await this.refunds.setReference(tx, r, remote.ref);
        const failedNow = remote.status === 'failed' || remote.status === 'cancelled';
        const event: RefundEvent = failedNow && r.status === 'succeeded' ? 'reversal_confirmed' : refundEventOf(remote.status);
        await this.refunds.apply(tx, b, p, r, event, { source: 'webhook', failureCode: remote.failureCode, providerRefundRef: remote.ref });
        return this.processedIn(tx, ev.id, r.id);
      }
      // A refund made on the gateway's dashboard. It may not take more than is left of the payment (plan 3.3, 3.3).
      if (remote.status === 'pending' || remote.status === 'succeeded') {
        const held = await tx.refund.aggregate({ where: { paymentId: p.id, status: { in: ['requested', 'pending', 'succeeded'] } }, _sum: { amountMinor: true } });
        if ((held._sum.amountMinor ?? 0n) + remote.amount.amountMinor > p.amountMinor) return this.refusedRefund(tx, ev.id, b.reference, p.id, 'refund_over_payment');
      }
      // Task 4.5 (P10): beyond what is left of the payment after its chargebacks, the gateway's refund is still recorded
      // (the money did go); the excess is a receivable and Oscar gets a task.
      let overCap = false;
      if (remote.status === 'pending' || remote.status === 'succeeded') {
        const [x] = await tx.$queryRaw<Array<{ refunds: bigint; withdrawn: bigint }>>`
          SELECT COALESCE((SELECT sum("amountMinor") FROM refunds WHERE "paymentId" = ${p.id}::uuid AND status IN ('requested', 'pending', 'succeeded')), 0)::bigint AS refunds,
                 COALESCE((SELECT sum("amountMinor") FROM disputes WHERE "paymentId" = ${p.id}::uuid AND "fundsWithdrawnAt" IS NOT NULL AND "fundsReinstatedAt" IS NULL), 0)::bigint AS withdrawn`;
        overCap = x!.refunds + x!.withdrawn + remote.amount.amountMinor > p.amountMinor;
      }
      const r = await this.refunds.createExternal(tx, b, p, remote);
      if (overCap) {
        await this.tasks.createSystemIn(tx, {
          title: `Refund at the payment gateway beyond what was left on booking ${b.reference}`,
          description: 'A refund made at the payment gateway, added to the chargebacks of this payment, is more than the payment. It is recorded; the difference is owed by the customer. Check the booking and the gateway.',
          entityType: 'Refund', entityId: r.id, sourceRef: `payments:refund_over_cap:${r.id}`,
        });
      }
      return this.processedIn(tx, ev.id, r.id);
    }, PAYMENT_TX_OPTIONS);
  }

  /**
   * A dispute event (task 4.5, plan section 5.3). Outside any transaction, through the account that received it: the
   * payment disputed and the dispute as the gateway sees it now (its word wins over the event's). Then booking, all its
   * payments and the dispute are locked, in that order.
   */
  private async processDispute(ev: { id: string; providerAccountId: string }, said: ProviderDispute): Promise<ProcessOutcome> {
    const accountId = ev.providerAccountId;
    const remotePayment = await this.gateway.call(accountId, 'retrieve', (provider, ctx) => provider.retrievePayment(ctx, { ref: said.paymentRef }));
    const current = await this.gateway.call(accountId, 'retrieve', async (provider, ctx) => (provider.retrieveDispute ? provider.retrieveDispute(ctx, said.ref) : null));
    if (!current) throw new AppError('dispute_not_confirmed_by_gateway', 'The gateway does not confirm this dispute');
    const match = remotePayment ? await this.matchPayment(accountId, remotePayment) : null;
    if (!match || !remotePayment || current.paymentRef !== said.paymentRef) return this.unknownPayment(ev.id);
    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: match.bookingId }, true);
      if (!b) throw notFound();
      await tx.$queryRaw`SELECT id FROM payments WHERE "bookingId" = ${b.id}::uuid ORDER BY id FOR UPDATE`;
      const p = await lockPayment(tx, b, match.id);
      if (!p) throw notFound();
      const status = await tx.webhookEvent.findUniqueOrThrow({ where: { id: ev.id }, select: { status: true } });
      if (status.status !== 'received' && status.status !== 'failed') return 'skipped' as const;
      const [owner] = await tx.$queryRaw<Array<{ erased: boolean }>>`SELECT ("anonymisedAt" IS NOT NULL) AS erased FROM customers WHERE id = ${b.customerId}::uuid`;
      await tx.webhookEvent.update({ where: { id: ev.id }, data: { bookingId: b.id, paymentId: p.id, ...(owner?.erased ? { rawBody: null } : {}) } });
      // The payment first (plan 0.1, P7): a dispute of money we have not seen arrive catches the payment up.
      if (p.status !== 'succeeded' && remotePayment.status === 'succeeded') {
        if (remotePayment.amount.amountMinor !== p.amountMinor || remotePayment.amount.currency !== p.currency || (p.providerPaymentRef !== null && p.providerPaymentRef !== remotePayment.ref)) {
          await this.attempts.mismatchTask(tx, p, b.reference);
          return this.ignoreIn(tx, ev.id, 'amount_or_currency_mismatch');
        }
        await this.machine.setReference(tx, p, remotePayment.ref);
        await this.machine.apply(tx, b, p, 'succeeded', { source: 'webhook' });
      }
      if (p.status !== 'succeeded' || p.providerPaymentRef !== remotePayment.ref) return this.refusedDispute(tx, ev.id, b.reference, p.id, 'dispute_of_uncollected_payment');
      const out = await this.disputes.applyRemote(tx, b, p, accountId, current, ev.id);
      if (out.kind === 'refused') return this.refusedDispute(tx, ev.id, b.reference, p.id, out.code);
      await tx.webhookEvent.update({ where: { id: ev.id }, data: { disputeId: out.disputeId, status: 'processed', processedAt: new Date(), attempts: { increment: 1 }, errorCode: null } });
      await this.tasks.closeSystemIn(tx, `payments:webhook_failed:${ev.id}`);
      return 'processed' as const;
    }, PAYMENT_TX_OPTIONS);
  }

  private async refusedDispute(tx: Prisma.TransactionClient, eventId: string, reference: string, paymentId: string, code: string): Promise<'ignored'> {
    await this.tasks.createSystemIn(tx, {
      title: `Dispute at the payment gateway not recorded on booking ${reference}`,
      description: `The payment gateway reported a dispute that cannot be recorded as it is (${code}). Nothing was posted; check the gateway and the booking.`,
      entityType: 'Payment', entityId: paymentId, sourceRef: `payments:dispute_refused:${eventId}`,
    });
    return this.ignoreIn(tx, eventId, code);
  }

  /** Our payment for the gateway's: by our id among this account's payments only (finding 2), then by reference. */
  private async matchPayment(accountId: string, remote: ProviderPayment): Promise<{ id: string; bookingId: string } | null> {
    const byId = remote.ourPaymentId && UUID.test(remote.ourPaymentId)
      ? await this.prisma.payment.findFirst({ where: { id: remote.ourPaymentId, providerAccountId: accountId }, select: { id: true, bookingId: true } })
      : null;
    return byId ?? this.prisma.payment.findFirst({ where: { providerAccountId: accountId, providerPaymentRef: remote.ref }, select: { id: true, bookingId: true } });
  }

  private unknownPayment(eventId: string): Promise<ProcessOutcome> {
    return runTransaction(this.prisma, async (tx) => {
      await this.tasks.createSystemIn(tx, {
        title: 'Payment webhook for an unknown payment',
        description: 'A payment gateway sent an event for a payment we cannot match. If money came in or went out, register it against the right booking.',
        entityType: 'WebhookEvent', entityId: eventId, sourceRef: `payments:unknown_event:${eventId}`,
      });
      return this.ignoreIn(tx, eventId, 'unknown_payment');
    });
  }

  /** A refund event that is not posted (plan 3.3, 3.3): visible with its code, and a task for Oscar. */
  private async refusedRefund(tx: Prisma.TransactionClient, eventId: string, reference: string, paymentId: string, code: string): Promise<'ignored'> {
    await this.tasks.createSystemIn(tx, {
      title: `Refund at the payment gateway not recorded on booking ${reference}`,
      description: `The payment gateway reported a refund that cannot be recorded as it is (${code}). Nothing was posted; check the gateway and the booking.`,
      entityType: 'Payment', entityId: paymentId, sourceRef: `payments:refund_refused:${eventId}`,
    });
    return this.ignoreIn(tx, eventId, code);
  }

  private async processedIn(tx: Prisma.TransactionClient, eventId: string, refundId: string): Promise<'processed'> {
    await tx.webhookEvent.update({ where: { id: eventId }, data: { refundId, status: 'processed', processedAt: new Date(), attempts: { increment: 1 }, errorCode: null } });
    await this.tasks.closeSystemIn(tx, `payments:webhook_failed:${eventId}`);
    return 'processed';
  }

  private ignore(id: string, code: string): Promise<ProcessOutcome> {
    return this.prisma.$transaction((tx) => this.ignoreIn(tx, id, code));
  }

  private async ignoreIn(tx: Prisma.TransactionClient, id: string, code: string): Promise<'ignored'> {
    await tx.webhookEvent.update({ where: { id }, data: { status: 'ignored', processedAt: new Date(), attempts: { increment: 1 }, errorCode: code } });
    await this.tasks.closeSystemIn(tx, `payments:webhook_failed:${id}`);
    return 'ignored';
  }
}
