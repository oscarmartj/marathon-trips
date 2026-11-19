// Refunds started from the panel (plan docs/plans/4.5-refunds-disputes.md, sections 3, 4 and 14): through the payment's
// gateway, or by Oscar from the bank for a transfer (P13). The amount is always what the payment can give back now,
// computed here under the booking's lock (P10); the request carries none.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RefundDestinationInput, RequestRefund } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { SECRET_BOX } from '../../../platform/auth/staff-auth.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import type { SecretBox } from '../../../platform/crypto/secret-box';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { safeError } from '../../../platform/errors/safe-error';
import { OutboxService } from '../../../platform/events/outbox.service';
import { ApiError, conflict, notFound, unprocessable } from '../../../platform/http/api-error';
import { IdempotencyService } from '../../../platform/idempotency/idempotency.service';
import { readBookingForPayments } from '../../bookings';
import type { LockedBooking } from '../../bookings';
import { MANUAL_KEY } from '../adapters/manual/manual';
import { bsbDigits, payeeProblems } from '../adapters/manual/instructions';
import { PAYMENT_EVENTS, lockPayment } from './attempt-state';
import type { LockedPayment } from './attempt-state';
import { ProviderGateway } from './gateway';
import { PAYMENT_TX_OPTIONS } from './payable-states';
import { ProviderError } from './provider';
import type { ProviderRefund } from './provider';
import { loadRefundable } from './refundable';
import { PaymentRefundStateMachine, lockRefund, refundEventOf, refundReviewTaskRef } from './refunds.service';
import type { LockedRefund } from './refunds.service';

type Tx = Prisma.TransactionClient;

/** Backoff of an unanswered gateway request (plan 4.5, 3.3 and 12.10), then a task: never a call after the key's lifetime. */
export const REFUND_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const REFUND_MAX_ATTEMPTS = 5;
/** Gateways keep idempotency keys for 24 hours (Stripe): we stop an hour before. */
export const REFUND_KEY_LIFETIME_MS = 23 * 3_600_000;
/** A manual refund still waiting for its transfer this long gets a task. */
export const MANUAL_REFUND_WAITING_MS = 7 * 86_400_000;

export { refundReviewTaskRef };
/** How long one sender (a request, the retry sweep or staff resolving) holds a gateway refund (review of the code, H1). */
export const REFUND_SEND_LEASE_SECONDS = 120;

const REFUND_SELECT = {
  id: true, paymentId: true, bookingId: true, origin: true, purpose: true, manualRefund: true, mode: true, amountMinor: true, currency: true, status: true,
  providerRefundRef: true, failureCode: true, destinationHint: true, requestAttempts: true, nextAttemptAt: true, version: true, createdAt: true, succeededAt: true,
} as const;

export interface RefundView {
  id: string;
  paymentId: string;
  bookingId: string;
  origin: string;
  purpose: string | null;
  manualRefund: boolean;
  amountMinor: string;
  currency: string;
  status: string;
  providerRefundRef: string | null;
  failureCode: string | null;
  destinationHint: string | null;
  hasDestination: boolean;
  version: number;
  createdAt: string;
  succeededAt: string | null;
}

export interface RefundableView {
  paymentId: string;
  paymentVersion: number;
  method: string;
  manual: boolean;
  refundableMinor: string;
  currency: string;
  /** Why nothing can be refunded from the app on this payment now; null when something can. */
  blockedReason: string | null;
}

const maskPayId = (v: string) => (v.length <= 4 ? '••••' : `${v.slice(0, 1)}•••${v.slice(-4)}`);

/** The masked hint a manual refund keeps of its destination (last digits only). */
export function destinationHint(d: Pick<RefundDestinationInput, 'payId' | 'bank'>): string {
  if (d.payId) return `PayID ${maskPayId(d.payId.value)}`;
  const bsb = bsbDigits(d.bank!.bsb);
  return `BSB ${bsb.slice(0, 3)}-••• acct •••${d.bank!.accountNumber.slice(-3)}`;
}

export const destinationAad = (refundId: string) => `refund:${refundId}:destination`;

@Injectable()
export class AppRefundsService {
  private readonly logger = new Logger('AppRefunds');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentRefundStateMachine) private readonly machine: PaymentRefundStateMachine,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
  ) {}

  /** What each succeeded payment of a booking can give back now, for the panel. */
  async refundableView(bookingId: string): Promise<RefundableView[]> {
    const mode = this.gateway.mode;
    const [rows, payments] = await Promise.all([
      this.prisma.$transaction((tx) => loadRefundable(tx, bookingId, mode)),
      this.prisma.payment.findMany({ where: { bookingId, mode, status: 'succeeded' }, select: { id: true, version: true, method: true, adapterKey: true, currency: true } }),
    ]);
    return rows.map((r) => {
      const p = payments.find((x) => x.id === r.paymentId)!;
      const manual = p.adapterKey === MANUAL_KEY;
      const caps = this.gateway.registry.get(p.adapterKey)?.manifest.capabilities.refunds ?? 'none';
      const blockedReason = r.blocked === 'disputed' ? 'payment_disputed' : r.blocked === 'external_refund_in_progress' ? 'external_refund_in_progress'
        : r.refundableMinor === 0n ? 'nothing_to_refund'
          : !manual && caps === 'none' ? 'refunds_not_supported'
            : !manual && caps === 'full' && r.refundableMinor < r.netMinor ? 'partial_refund_not_supported' : null;
      return { paymentId: p.id, paymentVersion: p.version, method: p.method, manual, refundableMinor: blockedReason ? '0' : r.refundableMinor.toString(), currency: p.currency, blockedReason };
    });
  }

  async view(id: string): Promise<RefundView> {
    const r = await this.prisma.refund.findUnique({ where: { id }, select: { ...REFUND_SELECT, destinationKeyVersion: true } });
    if (!r) throw notFound('refund_not_found', 'Refund not found');
    const { destinationKeyVersion, requestAttempts: _a, nextAttemptAt: _n, ...rest } = r;
    return {
      ...rest, amountMinor: r.amountMinor.toString(), hasDestination: destinationKeyVersion !== null,
      createdAt: r.createdAt.toISOString(), succeededAt: r.succeededAt?.toISOString() ?? null,
    };
  }

  /**
   * A refund from the panel (plan 4.5, 3.1 and 3.2). Idempotent on the client's key (a replay answers the refund as it
   * stands now; the reason is not part of the stored fingerprint). A gateway refund is sent at once; a manual one waits
   * for its destination and Oscar's transfer.
   */
  async request(paymentId: string, input: RequestRefund, key: string, actor: AuditActor): Promise<{ status: number; refund: RefundView }> {
    const outcome = await this.idempotency.run({
      actorType: 'staff', actorId: actor.id!, route: 'POST /admin/payments/payments/:id/refunds', key,
      body: { paymentId, paymentVersion: input.paymentVersion, purpose: input.purpose },
    }, async () => {
      const created = await this.create(paymentId, input, actor);
      if (created.manual) return { status: 201, resourceType: 'Refund', resourceId: created.id };
      const status = await this.send(created.id);
      if (status === 'refused') throw conflict('refund_refused_by_gateway', 'The payment gateway refused this refund. Nothing was refunded.', { refundId: created.id });
      return { status: status === 'unanswered' ? 202 : 201, resourceType: 'Refund', resourceId: created.id };
    });
    return { status: outcome.result.status, refund: await this.view(outcome.result.resourceId!) };
  }

  /** Transaction A (plan 4.5, 3.1): checks and caps with the booking and all its payments locked, then the row. */
  private async create(paymentId: string, input: RequestRefund, actor: AuditActor): Promise<{ id: string; manual: boolean }> {
    const row = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { bookingId: true, providerAccountId: true, adapterKey: true } });
    if (!row) throw notFound('payment_not_found', 'Payment not found');
    // Plan 0.1, P9: only overpayments go back from the app until 6.4 (cancellations) and the courtesy-refund task.
    if (input.purpose === 'cancellation') throw conflict('cancellation_refund_rejected_until_cancellations_exist', 'Refunds for a cancellation are not available yet.');
    if (input.purpose === 'price_reduction') throw conflict('price_reduction_refund_rejected_until_amendments_exist', 'Lower the price with a change to the booking: what was paid above it can then be refunded as an overpayment.');
    const { manifest } = await this.gateway.assertAllowed(row.providerAccountId, 'refund');
    const manual = row.adapterKey === MANUAL_KEY;
    if (!manual && manifest.capabilities.refunds === 'none') throw conflict('refunds_not_supported', 'This payment gateway cannot refund from the app. Refund it at the gateway.');
    return runTransaction(this.prisma, async (tx) => {
      const b = await this.lockBooking(tx, row.bookingId);
      const p = await lockPayment(tx, b, paymentId);
      if (!p) throw notFound('payment_not_found', 'Payment not found');
      if (p.status !== 'succeeded') throw conflict('payment_not_refundable', 'Only a payment that went through can be refunded');
      if (p.version !== input.paymentVersion) throw conflict('stale_payment_version', 'Someone else changed this payment. Reload and try again.');
      const entry = (await loadRefundable(tx, b.id, p.mode)).find((x) => x.paymentId === p.id);
      if (!entry) throw conflict('payment_not_refundable', 'Only a payment that went through can be refunded');
      if (entry.blocked === 'disputed') throw conflict('refund_of_disputed_payment_rejected', 'This payment is disputed by the cardholder: it cannot be refunded while the dispute stands.');
      if (entry.blocked === 'external_refund_in_progress') throw conflict('external_refund_in_progress', 'A refund made at the payment gateway is still in progress on this booking. Wait for it to settle.');
      if (entry.refundableMinor <= 0n) throw conflict('nothing_to_refund', 'Nothing paid on this payment is beyond what the booking owes.');
      if (!manual && manifest.capabilities.refunds === 'full' && entry.refundableMinor < entry.netMinor) throw conflict('partial_refund_not_supported', 'This payment gateway only refunds a payment in full.');
      const [inserted] = await tx.$queryRaw<Array<{ id: string }>>`
        WITH n AS (SELECT gen_random_uuid() AS id)
        INSERT INTO refunds (id, "paymentId", "bookingId", "providerAccountId", mode, currency, "amountMinor", origin, purpose, reason, status, "idempotencyKey", "requestedById", "manualRefund", "updatedAt")
        SELECT n.id, ${p.id}::uuid, ${b.id}::uuid, ${p.providerAccountId}::uuid, ${p.mode}::"PaymentMode", ${p.currency}, ${entry.refundableMinor}, 'app', ${input.purpose}::"RefundPurpose",
               ${input.reason}, 'requested', 'refund:app:' || n.id::text, ${actor.id}::uuid, ${manual}, clock_timestamp()
        FROM n RETURNING id::text AS id`;
      const id = inserted!.id;
      // The panel sends the version it read: a second tab (or a second click) with the same version now gets 409.
      const bumped = await tx.$executeRaw`UPDATE payments SET version = version + 1, "updatedAt" = clock_timestamp() WHERE id = ${p.id}::uuid AND version = ${p.version}`;
      if (bumped !== 1) throw conflict('stale_payment_version', 'Someone else changed this payment. Reload and try again.');
      await this.audit.record(tx, {
        actor, action: 'payments.refund.requested', entityType: 'Refund', entityId: id, model: 'Refund',
        after: { status: 'requested', amountMinor: entry.refundableMinor.toString(), currency: p.currency, purpose: input.purpose, origin: 'app', manualRefund: manual },
        reason: input.reason, context: { bookingId: b.id, paymentId: p.id },
      });
      await this.outbox.publish(tx, { type: PAYMENT_EVENTS.refundRequested, aggregateType: 'Refund', aggregateId: id, aggregateVersion: 0, payload: { refundId: id, paymentId: p.id, bookingId: b.id }, actorType: actor.type, actorId: actor.id ?? undefined });
      return { id, manual };
    }, PAYMENT_TX_OPTIONS);
  }

  /**
   * The call to the gateway, outside any transaction, then transaction B (plan 4.5, 3.2). Before any call the payment is
   * checked again for what makes a second payout possible (plan review, 2): a dispute, or a refund made at the gateway
   * since ours was asked; then nothing is sent and the refund goes to review.
   */
  async send(refundId: string, opts: { leased?: boolean } = {}): Promise<'settled' | 'unanswered' | 'refused' | 'review' | 'skipped'> {
    // One sender at a time (H1): the request, the sweep and staff resolving it each take the lease first.
    if (!opts.leased && !(await this.lease(refundId))) return 'skipped';
    const row = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { id: true, paymentId: true, bookingId: true, providerAccountId: true, amountMinor: true, currency: true, idempotencyKey: true, createdAt: true, status: true, origin: true, manualRefund: true, providerRefundRef: true, requestAttempts: true, payment: { select: { providerPaymentRef: true } } } });
    if (!row || row.origin !== 'app' || row.manualRefund || row.status !== 'requested' || row.providerRefundRef) return 'skipped';
    if (await this.secondPayoutRisk(this.prisma, row)) return this.toReview(refundId, 'payment_disputed_or_refunded_elsewhere');
    let remote: ProviderRefund | null = null;
    let error: ProviderError | null = null;
    try {
      remote = await this.gateway.call(row.providerAccountId, 'refund', (provider, ctx) => provider.createRefund(ctx, {
        paymentRef: row.payment.providerPaymentRef!, amount: { amountMinor: row.amountMinor, currency: row.currency }, idempotencyKey: row.idempotencyKey,
        metadata: { refundId: row.id, paymentId: row.paymentId, bookingId: row.bookingId }, createdAt: row.createdAt,
      }));
    } catch (err) {
      if (err instanceof ProviderError) error = err;
      else if (err instanceof ApiError) error = new ProviderError('provider_unavailable', true);
      else throw err;
    }
    return runTransaction(this.prisma, async (tx) => {
      const { b, p, r } = await this.lockRefundChain(tx, row.bookingId, row.paymentId, refundId);
      await this.unlease(tx, r.id);
      if (remote) {
        if (await this.machine.gatewayMovedFailedRefund(tx, b, p, r, remote, 'api')) return 'review' as const;
        if (r.providerRefundRef === null) await this.machine.setReference(tx, r, remote.ref);
        const to = await this.machine.apply(tx, b, p, r, refundEventOf(remote.status), { source: 'api', failureCode: remote.failureCode, providerRefundRef: remote.ref });
        if (to === null && r.status === 'requested') await this.bumpAttempt(tx, r.id, null);
        return 'settled' as const;
      }
      if (r.status !== 'requested') return 'settled' as const;
      if (error && !error.retryable) {
        await this.machine.apply(tx, b, p, r, 'failed', { source: 'api', failureCode: error.code });
        return 'refused' as const;
      }
      const attempts = row.requestAttempts + 1;
      const delay = REFUND_RETRY_DELAYS_MS[Math.min(attempts - 1, REFUND_RETRY_DELAYS_MS.length - 1)]!;
      await this.bumpAttempt(tx, r.id, attempts >= REFUND_MAX_ATTEMPTS ? null : new Date(Date.now() + delay));
      if (attempts >= REFUND_MAX_ATTEMPTS) await this.reviewTask(tx, b.reference, r.id, 'no_answer');
      return 'unanswered' as const;
    }, PAYMENT_TX_OPTIONS);
  }

  /**
   * The retry sweep (plan 4.5, 3.3): app gateway refunds still `requested` whose next attempt is due. Each is looked up
   * by its key first; found, it is adopted; not found and still within the key's lifetime, sent again with the same key
   * and the same parameters; otherwise it goes to review. Manual refunds are never here (plan review, 4).
   */
  async retryDue(now: Date = new Date(), limit = 50): Promise<string[]> {
    const due = await this.prisma.refund.findMany({
      where: { origin: 'app', manualRefund: false, status: 'requested', providerRefundRef: null, nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true },
    });
    const done: string[] = [];
    for (const d of due) {
      try {
        await this.retryOne(d.id, now);
        done.push(d.id);
      } catch (err) {
        this.logger.warn(`refund retry failed: ${safeError(err).code}`);
      }
    }
    return done;
  }

  async retryOne(refundId: string, now: Date = new Date()): Promise<string> {
    if (!(await this.lease(refundId))) return 'skipped';
    const row = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, select: { id: true, bookingId: true, paymentId: true, providerAccountId: true, idempotencyKey: true, createdAt: true, payment: { select: { providerPaymentRef: true } } } });
    if (await this.secondPayoutRisk(this.prisma, { ...row })) return this.toReview(refundId, 'payment_disputed_or_refunded_elsewhere');
    let found: ProviderRefund | null;
    try {
      found = await this.gateway.call(row.providerAccountId, 'retrieve', (provider, ctx) => provider.retrieveRefund(ctx, { idempotencyKey: row.idempotencyKey, paymentRef: row.payment.providerPaymentRef!, createdAt: row.createdAt }));
    } catch (err) {
      // No answer to the lookup: never send blind; try again later (or go to review once the attempts run out).
      return runTransaction(this.prisma, async (tx) => {
        const { b, r } = await this.lockRefundChain(tx, row.bookingId, row.paymentId, refundId);
        await this.unlease(tx, r.id);
        if (r.status !== 'requested') return 'settled';
        const cur = await tx.refund.findUniqueOrThrow({ where: { id: r.id }, select: { requestAttempts: true } });
        const attempts = cur.requestAttempts + 1;
        await this.bumpAttempt(tx, r.id, attempts >= REFUND_MAX_ATTEMPTS ? null : new Date(now.getTime() + REFUND_RETRY_DELAYS_MS[Math.min(attempts - 1, 3)]!));
        if (attempts >= REFUND_MAX_ATTEMPTS) await this.reviewTask(tx, b.reference, r.id, safeError(err).code);
        return 'unanswered';
      }, PAYMENT_TX_OPTIONS);
    }
    if (found) return this.adopt(refundId, found);
    if (now.getTime() - row.createdAt.getTime() >= REFUND_KEY_LIFETIME_MS) return this.toReview(refundId, 'key_lifetime_over');
    return this.send(refundId, { leased: true });
  }

  /**
   * A gateway refund with no answer (plan review, 3): staff ask for it to be settled. The gateway is asked by our key;
   * found, its state is taken; the gateway says it does not exist, the refund fails (`resolved_by_staff`) and its money
   * is free again; any gateway error changes nothing.
   */
  async resolve(refundId: string, version: number, actor: AuditActor): Promise<RefundView> {
    const row = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { id: true, bookingId: true, paymentId: true, providerAccountId: true, idempotencyKey: true, createdAt: true, origin: true, manualRefund: true, status: true, version: true, providerRefundRef: true, payment: { select: { providerPaymentRef: true } } } });
    if (!row) throw notFound('refund_not_found', 'Refund not found');
    if (row.origin !== 'app' || row.manualRefund || (row.status !== 'requested' && row.status !== 'pending')) throw conflict('refund_not_resolvable', 'Only a refund from the app still waiting for its gateway can be resolved here');
    if (row.version !== version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
    // H1: stop the sweep and hold the lease, so no request is sent while we ask the gateway and decide.
    if (row.status === 'requested' && row.providerRefundRef === null && !(await this.lease(refundId, true))) throw conflict('refund_send_in_progress', 'This refund is being sent to the gateway right now. Try again in a few minutes.');
    let found: ProviderRefund | null;
    try {
      found = await this.gateway.call(row.providerAccountId, 'retrieve', (provider, ctx) => (row.providerRefundRef
        ? provider.retrieveRefund(ctx, { ref: row.providerRefundRef })
        : provider.retrieveRefund(ctx, { idempotencyKey: row.idempotencyKey, paymentRef: row.payment.providerPaymentRef!, createdAt: row.createdAt })));
    } catch {
      await this.prisma.$executeRaw`UPDATE refunds SET "sendingUntil" = NULL, "updatedAt" = clock_timestamp() WHERE id = ${refundId}::uuid`;
      throw new ApiError(502, 'gateway_unavailable', 'The payment gateway did not answer. Nothing was changed; try again later.');
    }
    await runTransaction(this.prisma, async (tx) => {
      const { b, p, r } = await this.lockRefundChain(tx, row.bookingId, row.paymentId, refundId);
      await this.unlease(tx, r.id);
      if (r.version !== version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      if (found) {
        if (found.amount.amountMinor !== r.amountMinor || found.amount.currency !== r.currency) throw conflict('refund_amount_mismatch', 'The gateway holds this refund with another amount. Check it at the gateway.');
        if (r.providerRefundRef === null) await this.machine.setReference(tx, r, found.ref);
        await this.machine.apply(tx, b, p, r, refundEventOf(found.status), { source: 'staff', actor, failureCode: found.failureCode, providerRefundRef: found.ref });
      } else {
        await this.machine.apply(tx, b, p, r, 'failed', { source: 'staff', actor, failureCode: 'resolved_by_staff' });
      }
      await this.audit.record(tx, { actor, action: 'payments.refund.resolved', entityType: 'Refund', entityId: r.id, context: { found: found !== null, bookingId: b.id } });
      await this.tasks.closeSystemIn(tx, refundReviewTaskRef(r.id));
    }, PAYMENT_TX_OPTIONS);
    return this.view(refundId);
  }

  // ---- Manual refunds (P13) ----

  /** Stores where a manual refund goes (plan review, 11: its own step, outside any idempotency record). Once. */
  async setDestination(refundId: string, input: RefundDestinationInput, actor: AuditActor): Promise<RefundView> {
    const problems = payeeProblems({ payeeName: input.accountName, payId: input.payId, bank: input.bank });
    if (problems.length > 0) throw unprocessable('destination_invalid', 'These bank details are not valid', { problems });
    const row = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { bookingId: true, paymentId: true } });
    if (!row) throw notFound('refund_not_found', 'Refund not found');
    await runTransaction(this.prisma, async (tx) => {
      const { r } = await this.lockRefundChain(tx, row.bookingId, row.paymentId, refundId);
      const cur = await tx.refund.findUniqueOrThrow({ where: { id: r.id }, select: { version: true, manualRefund: true, status: true, destinationHint: true } });
      if (!cur.manualRefund) throw conflict('destination_only_for_manual_refunds', 'Only a refund of a bank transfer is sent to an account');
      if (cur.status !== 'requested' || cur.destinationHint !== null) throw conflict('destination_already_set', 'This refund already has its destination');
      if (cur.version !== input.version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      const plain = JSON.stringify({ accountName: input.accountName, payId: input.payId, bank: input.bank ? { bsb: bsbDigits(input.bank.bsb), accountNumber: input.bank.accountNumber } : null });
      const sealed = this.box.encrypt(plain, destinationAad(r.id));
      const hint = destinationHint(input);
      const n = await tx.$executeRaw`
        UPDATE refunds SET "destinationCiphertext" = ${sealed.ciphertext}, "destinationKeyVersion" = ${sealed.keyVersion}, "destinationHint" = ${hint}, version = version + 1, "updatedAt" = clock_timestamp()
        WHERE id = ${r.id}::uuid AND version = ${input.version} AND status = 'requested' AND "destinationHint" IS NULL`;
      if (n !== 1) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      await this.audit.record(tx, { actor, action: 'payments.refund.destination_set', entityType: 'Refund', entityId: r.id, model: 'Refund', after: { destinationCiphertext: '[changed]', destinationHint: hint }, context: { bookingId: row.bookingId } });
    }, PAYMENT_TX_OPTIONS);
    return this.view(refundId);
  }

  /** The destination in clear, to make the transfer (step-up on the route, audited, only while requested). */
  async destination(refundId: string, actor: AuditActor): Promise<{ accountName: string; payId: { type: string; value: string } | null; bank: { bsb: string; accountNumber: string } | null; amountMinor: string; currency: string }> {
    const r = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { id: true, bookingId: true, status: true, manualRefund: true, destinationCiphertext: true, destinationKeyVersion: true, amountMinor: true, currency: true } });
    if (!r) throw notFound('refund_not_found', 'Refund not found');
    if (!r.manualRefund || r.status !== 'requested' || !r.destinationCiphertext || r.destinationKeyVersion === null) throw conflict('destination_not_available', 'This refund has no destination to show');
    const d = JSON.parse(this.box.decrypt(r.destinationCiphertext, r.destinationKeyVersion, destinationAad(r.id))) as { accountName: string; payId: { type: string; value: string } | null; bank: { bsb: string; accountNumber: string } | null };
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action: 'payments.refund.destination_viewed', entityType: 'Refund', entityId: r.id, context: { bookingId: r.bookingId } }));
    return { ...d, amountMinor: r.amountMinor.toString(), currency: r.currency };
  }

  /** Oscar sent the money from the bank: the refund succeeds with the movement's reference, once (P13). */
  async confirmManual(refundId: string, input: { version: number; bankReference: string }, actor: AuditActor): Promise<RefundView> {
    const row = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { bookingId: true, paymentId: true, providerRefundRef: true, status: true } });
    if (!row) throw notFound('refund_not_found', 'Refund not found');
    // The same confirmation again (a second click): the refund as it is, nothing posted twice.
    if (row.status === 'succeeded' && row.providerRefundRef === input.bankReference) return this.view(refundId);
    try {
      await runTransaction(this.prisma, async (tx) => {
        const { b, p, r } = await this.lockRefundChain(tx, row.bookingId, row.paymentId, refundId);
        const cur = await tx.refund.findUniqueOrThrow({ where: { id: r.id }, select: { version: true, manualRefund: true, destinationHint: true } });
        if (!r.manualRefund) throw conflict('refund_not_manual', 'Only a refund of a bank transfer is confirmed by hand');
        if (r.status !== 'requested') throw conflict('refund_state_changed', 'This refund is no longer waiting for its transfer');
        if (cur.version !== input.version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
        if (cur.destinationHint === null) throw conflict('destination_required', 'Record where the money goes before confirming it was sent');
        await this.machine.apply(tx, b, p, r, 'succeeded', { source: 'staff', actor, providerRefundRef: input.bankReference, confirmedById: actor.id! });
        await this.audit.record(tx, { actor, action: 'payments.refund.manual_confirmed', entityType: 'Refund', entityId: r.id, model: 'Refund', after: { providerRefundRef: input.bankReference, status: 'succeeded' }, context: { bookingId: b.id } });
        await this.tasks.closeSystemIn(tx, `payments:manual_refund_waiting:${r.id}`);
      }, PAYMENT_TX_OPTIONS);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('bank_reference_already_used', 'This bank reference is already recorded for another refund');
      throw err;
    }
    return this.view(refundId);
  }

  /** The transfer will not be made: the refund fails, its money is free again and the destination is dropped. */
  async cancelManual(refundId: string, version: number, actor: AuditActor): Promise<RefundView> {
    const row = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { bookingId: true, paymentId: true } });
    if (!row) throw notFound('refund_not_found', 'Refund not found');
    await runTransaction(this.prisma, async (tx) => {
      const { b, p, r } = await this.lockRefundChain(tx, row.bookingId, row.paymentId, refundId);
      if (!r.manualRefund) throw conflict('refund_not_manual', 'Only a refund of a bank transfer is cancelled by hand');
      if (r.status !== 'requested') throw conflict('refund_state_changed', 'This refund is no longer waiting for its transfer');
      if (r.version !== version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      await this.machine.apply(tx, b, p, r, 'failed', { source: 'staff', actor, failureCode: 'cancelled_by_staff' });
      await this.tasks.closeSystemIn(tx, `payments:manual_refund_waiting:${r.id}`);
    }, PAYMENT_TX_OPTIONS);
    return this.view(refundId);
  }

  /** Manual refunds still waiting for their transfer after a week: one task each. */
  async flagWaitingManual(now: Date = new Date()): Promise<string[]> {
    const rows = await this.prisma.refund.findMany({ where: { manualRefund: true, status: 'requested', createdAt: { lte: new Date(now.getTime() - MANUAL_REFUND_WAITING_MS) } }, select: { id: true }, take: 200 });
    const flagged: string[] = [];
    for (const r of rows) {
      // Review of the code, L3: one task per refund, ever; closing it without acting does not bring it back every sweep.
      if ((await this.prisma.task.count({ where: { sourceRef: `payments:manual_refund_waiting:${r.id}` } })) > 0) continue;
      flagged.push(r.id);
      await this.prisma.$transaction((tx) => this.tasks.createSystemIn(tx, {
        title: 'A bank transfer refund is still waiting to be sent',
        description: 'A refund of a bank transfer was asked for more than a week ago and is not confirmed. Send it from the bank and confirm it with its reference, or cancel it.',
        entityType: 'Refund', entityId: r.id, sourceRef: `payments:manual_refund_waiting:${r.id}`,
      }));
    }
    return flagged;
  }

  // ---- helpers ----

  private async adopt(refundId: string, found: ProviderRefund): Promise<string> {
    const row = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, select: { bookingId: true, paymentId: true } });
    return runTransaction(this.prisma, async (tx) => {
      const { b, p, r } = await this.lockRefundChain(tx, row.bookingId, row.paymentId, refundId);
      if (found.amount.amountMinor !== r.amountMinor || found.amount.currency !== r.currency) {
        await this.toReviewIn(tx, b.reference, r, 'refund_amount_mismatch');
        return 'review';
      }
      await this.unlease(tx, r.id);
      if (await this.machine.gatewayMovedFailedRefund(tx, b, p, r, found, 'sweep')) return 'review';
      if (r.providerRefundRef === null) await this.machine.setReference(tx, r, found.ref);
      await this.machine.apply(tx, b, p, r, refundEventOf(found.status), { source: 'sweep', failureCode: found.failureCode, providerRefundRef: found.ref });
      return 'settled';
    }, PAYMENT_TX_OPTIONS);
  }

  /**
   * A dispute on the payment (open, evidence submitted or lost), or a refund made on the gateway's dashboard since ours
   * was asked: a call now could pay the customer twice (plan review, 2).
   */
  private async secondPayoutRisk(db: Pick<Tx, '$queryRaw'>, row: { bookingId: string; createdAt: Date }): Promise<boolean> {
    // Re-review, 2: the cap is per booking, so any payment of the booking counts, not only this refund's.
    const [x] = await db.$queryRaw<Array<{ risk: boolean }>>`
      SELECT (EXISTS (SELECT 1 FROM disputes d WHERE d."bookingId" = ${row.bookingId}::uuid AND d.status IN ('open', 'evidence_submitted', 'lost'))
           OR EXISTS (SELECT 1 FROM refunds r WHERE r."bookingId" = ${row.bookingId}::uuid AND r.origin = 'external' AND r."createdAt" >= ${row.createdAt}
                        AND r.status IN ('pending', 'succeeded'))) AS risk`;
    return x?.risk === true;
  }

  private async toReview(refundId: string, code: string): Promise<'review'> {
    const row = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, select: { bookingId: true, paymentId: true } });
    await runTransaction(this.prisma, async (tx) => {
      const { b, r } = await this.lockRefundChain(tx, row.bookingId, row.paymentId, refundId);
      await this.unlease(tx, r.id);
      if (r.status === 'requested') await this.toReviewIn(tx, b.reference, r, code);
    }, PAYMENT_TX_OPTIONS);
    return 'review';
  }

  private async toReviewIn(tx: Tx, reference: string, r: LockedRefund, code: string): Promise<void> {
    await tx.$executeRaw`UPDATE refunds SET "nextAttemptAt" = NULL, "updatedAt" = clock_timestamp() WHERE id = ${r.id}::uuid`;
    await this.reviewTask(tx, reference, r.id, code);
  }

  private async reviewTask(tx: Tx, reference: string, refundId: string, code: string): Promise<void> {
    await this.tasks.createSystemIn(tx, {
      title: `Refund on booking ${reference} needs checking at the payment gateway`,
      description: `A refund asked for in the app has not been sent or has no answer (${code.slice(0, 64)}). Nothing more is sent automatically. Check the gateway, then resolve the refund in the booking's payments.`,
      entityType: 'Refund', entityId: refundId, sourceRef: refundReviewTaskRef(refundId),
    });
    await this.audit.record(tx, { actor: { type: 'system', id: null }, action: 'payments.refund.review', entityType: 'Refund', entityId: refundId, context: { code: code.slice(0, 64) } });
  }

  /**
   * Takes the send lease of a gateway app refund still `requested` without a reference (review of the code, H1): one
   * compare-and-set, so a request, the sweep and staff resolving never talk to the gateway about it at once. With
   * `stopSweep`, the retry schedule is dropped in the same statement (staff take it over).
   */
  private async lease(refundId: string, stopSweep = false): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE refunds SET "sendingUntil" = clock_timestamp() + make_interval(secs => ${REFUND_SEND_LEASE_SECONDS}), "updatedAt" = clock_timestamp(),
        "nextAttemptAt" = CASE WHEN ${stopSweep} THEN NULL ELSE "nextAttemptAt" END
      WHERE id = ${refundId}::uuid AND origin = 'app' AND NOT "manualRefund" AND status = 'requested' AND "providerRefundRef" IS NULL
        AND ("sendingUntil" IS NULL OR "sendingUntil" < clock_timestamp())`;
    return n === 1;
  }

  private async unlease(tx: Tx, refundId: string): Promise<void> {
    await tx.$executeRaw`UPDATE refunds SET "sendingUntil" = NULL WHERE id = ${refundId}::uuid AND "sendingUntil" IS NOT NULL`;
  }

  private async bumpAttempt(tx: Tx, refundId: string, next: Date | null): Promise<void> {
    await tx.$executeRaw`UPDATE refunds SET "requestAttempts" = "requestAttempts" + 1, "nextAttemptAt" = ${next}, "updatedAt" = clock_timestamp() WHERE id = ${refundId}::uuid AND status = 'requested'`;
  }

  /** Booking, then every payment of the booking by id (plan 0.1, 6.3, refunds and disputes). */
  private async lockBooking(tx: Tx, bookingId: string): Promise<LockedBooking> {
    const b = await readBookingForPayments(tx, { id: bookingId }, true);
    if (!b) throw notFound('booking_not_found', 'Booking not found');
    await tx.$queryRaw`SELECT id FROM payments WHERE "bookingId" = ${bookingId}::uuid ORDER BY id FOR UPDATE`;
    return b;
  }

  private async lockRefundChain(tx: Tx, bookingId: string, paymentId: string, refundId: string): Promise<{ b: LockedBooking; p: LockedPayment; r: LockedRefund }> {
    const b = await this.lockBooking(tx, bookingId);
    const p = await lockPayment(tx, b, paymentId);
    const r = p ? await lockRefund(tx, p, refundId) : null;
    if (!p || !r) throw notFound('refund_not_found', 'Refund not found');
    return { b, p, r };
  }
}

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return e?.code === 'P2002' || e?.code === '23505' || e?.meta?.code === '23505' || /unique constraint|duplicate key/i.test(e?.message ?? '');
};
