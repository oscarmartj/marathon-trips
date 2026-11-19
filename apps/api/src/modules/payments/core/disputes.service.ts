// Disputes and chargebacks (plan docs/plans/4.5-refunds-disputes.md, sections 5 and 6). The status only moves forward;
// money moves only with the funds facts (withdrawn, reinstated), once each, whatever order the events come in.
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { sha256Hex } from '../../../platform/crypto/hmac';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { OutboxService } from '../../../platform/events/outbox.service';
import { conflict, notFound } from '../../../platform/http/api-error';
import type { LockedBooking } from '../../bookings';
import { readBookingForPayments } from '../../bookings';
import { PAYMENT_EVENTS } from './attempt-state';
import type { LockedPayment } from './attempt-state';
import { LedgerService } from './ledger.service';
import { PAYMENT_TX_OPTIONS } from './payable-states';
import type { ProviderDispute, ProviderDisputeStatus } from './provider';
import { DISPUTE_REASON_CODES } from './provider';
import { PaymentRefundStateMachine } from './refunds.service';
import { PaymentCoverageService } from './coverage.service';

type Tx = Prisma.TransactionClient;
export type DisputeStatusName = ProviderDisputeStatus;

const RANK: Readonly<Record<DisputeStatusName, number>> = { open: 0, evidence_submitted: 1, won: 2, lost: 2, closed: 2 };
const FINAL: ReadonlySet<DisputeStatusName> = new Set(['won', 'lost', 'closed']);

/** Every pair the trigger of migration 0035 allows (checked by a test against it). */
export const DISPUTE_STATUS_PAIRS: ReadonlyArray<readonly [DisputeStatusName, DisputeStatusName]> = [
  ['open', 'evidence_submitted'], ['open', 'won'], ['open', 'lost'], ['open', 'closed'],
  ['evidence_submitted', 'won'], ['evidence_submitted', 'lost'], ['evidence_submitted', 'closed'],
];

/**
 * The status table of plan 4.5, 5.2: `move` to a later status, `none` for the same or an earlier one, `review` for a
 * different final status after a final one (won after lost): nothing changes and Oscar checks it.
 */
export function nextDisputeStatus(from: DisputeStatusName, said: DisputeStatusName): { action: 'move'; to: DisputeStatusName } | { action: 'none' } | { action: 'review' } {
  if (from === said) return { action: 'none' };
  if (FINAL.has(from)) return { action: 'review' };
  if (RANK[said] <= RANK[from]) return { action: 'none' };
  return { action: 'move', to: said };
}

export interface LockedDispute {
  id: string;
  paymentId: string;
  bookingId: string;
  providerAccountId: string;
  status: DisputeStatusName;
  version: number;
  mode: 'test' | 'live';
  amountMinor: bigint;
  currency: string;
  fundsWithdrawnAt: Date | null;
  fundsReinstatedAt: Date | null;
}

async function lockDispute(tx: Tx, p: LockedPayment, id: string): Promise<LockedDispute | null> {
  const rows = await tx.$queryRaw<LockedDispute[]>`
    SELECT id::text AS id, "paymentId"::text AS "paymentId", "bookingId"::text AS "bookingId", "providerAccountId"::text AS "providerAccountId", status::text AS status,
           version, mode::text AS mode, "amountMinor", currency, "fundsWithdrawnAt", "fundsReinstatedAt"
    FROM disputes WHERE id = ${id}::uuid FOR UPDATE`;
  const d = rows[0] ?? null;
  if (d && d.paymentId !== p.id) throw conflict('dispute_lock_order', 'A dispute can only be locked after its own payment');
  return d;
}

export const disputeTaskRef = (id: string) => `payments:dispute:${id}`;

export type DisputeOutcome = { kind: 'processed'; disputeId: string } | { kind: 'refused'; code: string };

@Injectable()
export class PaymentDisputesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(PaymentRefundStateMachine) private readonly refunds: PaymentRefundStateMachine,
    @Inject(PaymentCoverageService) private readonly coverage: PaymentCoverageService,
  ) {}

  /**
   * What the gateway says of a dispute, with booking, payment (all of the booking's) and dispute locked by the caller
   * (plan 4.5, 5.3): created or moved forward, then the funds facts posted if they are not yet.
   */
  async applyRemote(tx: Tx, b: LockedBooking, p: LockedPayment, accountId: string, remote: ProviderDispute, eventId: string): Promise<DisputeOutcome> {
    if (remote.amount.currency !== p.currency) return { kind: 'refused', code: 'dispute_currency_mismatch' };
    if (remote.amount.amountMinor <= 0n || remote.amount.amountMinor > p.amountMinor) return { kind: 'refused', code: 'dispute_amount_over_payment' };
    const reason = (DISPUTE_REASON_CODES as readonly string[]).includes(remote.reasonCode) ? remote.reasonCode : 'other';
    const known = await tx.dispute.findFirst({ where: { providerAccountId: accountId, providerDisputeRef: remote.ref }, select: { id: true } });
    let d: LockedDispute;
    if (!known) {
      const [row] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO disputes (id, "paymentId", "bookingId", "providerAccountId", mode, currency, "providerDisputeRef", "amountMinor", "reasonCode", status, "evidenceDueBy", "updatedAt")
        VALUES (gen_random_uuid(), ${p.id}::uuid, ${b.id}::uuid, ${accountId}::uuid, ${p.mode}::"PaymentMode", ${p.currency}, ${remote.ref}, ${remote.amount.amountMinor}, ${reason},
                ${remote.status}::"DisputeStatus", ${remote.evidenceDueBy ?? null}, clock_timestamp())
        RETURNING id::text AS id`;
      d = (await lockDispute(tx, p, row!.id))!;
      await this.audit.record(tx, {
        actor: SYSTEM_ACTOR, action: 'payments.dispute.opened', entityType: 'Dispute', entityId: d.id,
        after: { status: remote.status, amountMinor: d.amountMinor.toString(), currency: d.currency, reasonCode: reason }, context: { bookingId: b.id, paymentId: p.id },
      });
      await this.outbox.publish(tx, { type: PAYMENT_EVENTS.disputeOpened, aggregateType: 'Dispute', aggregateId: d.id, aggregateVersion: 0, payload: { disputeId: d.id, paymentId: p.id, bookingId: b.id }, actorType: 'system' });
      await this.tasks.createSystemIn(tx, {
        title: `Payment disputed on booking ${b.reference}`,
        description: 'The cardholder disputed a payment with their bank. Download the evidence package from the booking\'s payments, submit it at the payment gateway before the due date, then mark it as submitted. Reminders and new payments are stopped while the dispute is open.',
        dueAt: remote.evidenceDueBy ? new Date(remote.evidenceDueBy.getTime() - 2 * 86_400_000) : null,
        entityType: 'Dispute', entityId: d.id, sourceRef: disputeTaskRef(d.id),
      });
      if (FINAL.has(remote.status)) await this.outcomeTask(tx, b, d.id, remote.status);
    } else {
      d = (await lockDispute(tx, p, known.id))!;
      if (d.amountMinor !== remote.amount.amountMinor) return { kind: 'refused', code: 'dispute_amount_changed' };
      const next = nextDisputeStatus(d.status, remote.status);
      if (next.action === 'move') await this.move(tx, b, d, next.to, SYSTEM_ACTOR, 'webhook');
      if (next.action === 'review') {
        await this.tasks.createSystemIn(tx, {
          title: `Dispute on booking ${b.reference} reported two different outcomes`,
          description: `The payment gateway now reports this dispute as ${remote.status}, after ${d.status}. Nothing was changed; check the dispute at the gateway.`,
          entityType: 'Dispute', entityId: d.id, sourceRef: `payments:dispute_review:${eventId}`,
        });
      }
    }
    await this.applyFunds(tx, b, p, d, remote);
    return { kind: 'processed', disputeId: d.id };
  }

  /** Staff record that they submitted the evidence at the gateway (plan 4.5, 5.4). Only from open. */
  async markEvidenceSubmitted(disputeId: string, version: number, actor: AuditActor): Promise<{ id: string; status: string; version: number }> {
    const row = await this.prisma.dispute.findUnique({ where: { id: disputeId }, select: { bookingId: true, paymentId: true } });
    if (!row) throw notFound('dispute_not_found', 'Dispute not found');
    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: row.bookingId }, true);
      if (!b) throw notFound('booking_not_found', 'Booking not found');
      await tx.$queryRaw`SELECT id FROM payments WHERE "bookingId" = ${b.id}::uuid ORDER BY id FOR UPDATE`;
      const p = { id: row.paymentId } as LockedPayment;
      const d = await lockDispute(tx, p, disputeId);
      if (!d) throw notFound('dispute_not_found', 'Dispute not found');
      if (d.version !== version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      if (d.status !== 'open') throw conflict('dispute_not_open', 'Only an open dispute can be marked as submitted');
      await this.move(tx, b, d, 'evidence_submitted', actor, 'staff', actor.id ?? undefined);
      return { id: d.id, status: d.status, version: d.version };
    }, PAYMENT_TX_OPTIONS);
  }

  /** One change of status (and, when staff mark it, who submitted the evidence), compare-and-set. */
  private async move(tx: Tx, b: LockedBooking, d: LockedDispute, to: DisputeStatusName, actor: AuditActor, source: 'webhook' | 'staff', evidenceBy?: string): Promise<void> {
    const n = await tx.$executeRaw`
      UPDATE disputes SET status = ${to}::"DisputeStatus", version = version + 1, "updatedAt" = clock_timestamp(),
        "evidenceSubmittedAt" = CASE WHEN ${evidenceBy ?? null}::uuid IS NOT NULL THEN clock_timestamp() ELSE "evidenceSubmittedAt" END,
        "evidenceSubmittedById" = COALESCE("evidenceSubmittedById", ${evidenceBy ?? null}::uuid)
      WHERE id = ${d.id}::uuid AND status = ${d.status}::"DisputeStatus"`;
    if (n !== 1) throw conflict('dispute_state_changed', 'This dispute changed. Try again.');
    const from = d.status;
    d.status = to;
    d.version += 1;
    await this.audit.record(tx, { actor, action: 'payments.dispute.status_changed', entityType: 'Dispute', entityId: d.id, before: { status: from }, after: { status: to }, context: { from, to, source, bookingId: b.id } });
    await this.outbox.publish(tx, { type: PAYMENT_EVENTS.disputeChanged, aggregateType: 'Dispute', aggregateId: d.id, aggregateVersion: d.version, payload: { disputeId: d.id, bookingId: b.id, from, to }, actorType: actor.type, actorId: actor.id ?? undefined });
    if (FINAL.has(to)) {
      await this.tasks.closeSystemIn(tx, disputeTaskRef(d.id));
      await this.outcomeTask(tx, b, d.id, to);
    }
  }

  private async outcomeTask(tx: Tx, b: LockedBooking, disputeId: string, to: DisputeStatusName): Promise<void> {
    await this.tasks.createSystemIn(tx, {
      title: `Dispute on booking ${b.reference} ${to === 'won' ? 'won' : to === 'lost' ? 'lost' : 'closed'}`,
      description: to === 'lost'
        ? 'The bank decided for the cardholder. The money it took is recorded; check the booking (cancel or change it) and close the review task to allow payments again.'
        : 'The dispute ended. Check the booking, then close its review task if there is one, to allow reminders and payments again.',
      entityType: 'Dispute', entityId: disputeId, sourceRef: `payments:dispute_outcome:${disputeId}`,
    });
  }

  /**
   * The funds facts (plan 4.5, 5.3 and 14.10): withdrawn and reinstated are cumulative at the gateway, each posted once
   * here; a reinstatement whose withdrawal we never saw posts both. All withdrawals of a payment never exceed it.
   */
  private async applyFunds(tx: Tx, b: LockedBooking, p: LockedPayment, d: LockedDispute, remote: ProviderDispute): Promise<void> {
    const wantWithdrawn = remote.fundsWithdrawn || remote.fundsReinstated;
    if (wantWithdrawn && d.fundsWithdrawnAt === null) {
      const [held] = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(sum("amountMinor"), 0)::bigint AS total FROM disputes WHERE "paymentId" = ${p.id}::uuid AND "fundsWithdrawnAt" IS NOT NULL AND "fundsReinstatedAt" IS NULL`;
      if ((held?.total ?? 0n) + d.amountMinor > p.amountMinor) {
        await this.tasks.createSystemIn(tx, {
          title: `Chargebacks above the payment on booking ${b.reference}`,
          description: 'The payment gateway reports more money taken back for disputes than this payment was for. Nothing was posted; check the disputes at the gateway.',
          entityType: 'Dispute', entityId: d.id, sourceRef: `payments:chargeback_over_payment:${d.id}`,
        });
        return;
      }
      await tx.$executeRaw`UPDATE disputes SET "fundsWithdrawnAt" = clock_timestamp(), version = version + 1, "updatedAt" = clock_timestamp() WHERE id = ${d.id}::uuid AND "fundsWithdrawnAt" IS NULL`;
      d.fundsWithdrawnAt = new Date();
      d.version += 1;
      await this.ledger.postChargebackWithdrawn(tx, b, d);
      await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'payments.chargeback.withdrawn', entityType: 'Dispute', entityId: d.id, context: { bookingId: b.id, paymentId: p.id } });
      await this.outbox.publish(tx, { type: PAYMENT_EVENTS.chargebackWithdrawn, aggregateType: 'Dispute', aggregateId: d.id, aggregateVersion: d.version, payload: { disputeId: d.id, bookingId: b.id }, actorType: 'system' });
      // Money out: under review whatever the coverage (plan review, 6), then the coverage rule.
      await this.refunds.afterMoneyOut(tx, b, { disputeId: d.id }, SYSTEM_ACTOR, { forceReview: true });
    }
    if (remote.fundsReinstated && d.fundsReinstatedAt === null && d.fundsWithdrawnAt !== null) {
      await tx.$executeRaw`UPDATE disputes SET "fundsReinstatedAt" = clock_timestamp(), version = version + 1, "updatedAt" = clock_timestamp() WHERE id = ${d.id}::uuid AND "fundsReinstatedAt" IS NULL`;
      d.fundsReinstatedAt = new Date();
      d.version += 1;
      await this.ledger.postChargebackReinstated(tx, b, d);
      await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'payments.chargeback.reinstated', entityType: 'Dispute', entityId: d.id, context: { bookingId: b.id, paymentId: p.id } });
      await this.outbox.publish(tx, { type: PAYMENT_EVENTS.chargebackReinstated, aggregateType: 'Dispute', aggregateId: d.id, aggregateVersion: d.version, payload: { disputeId: d.id, bookingId: b.id }, actorType: 'system' });
      await this.coverage.apply(tx, b, SYSTEM_ACTOR);
    }
  }

  /**
   * The evidence package (plan 4.5, section 6), built now from immutable or audited records and never stored. After the
   * customer's erasure it keeps what is not personal and says so (plan review, 7).
   */
  async evidence(disputeId: string, actor: AuditActor): Promise<{ filename: string; body: string }> {
    const d = await this.prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!d) throw notFound('dispute_not_found', 'Dispute not found');
    const booking = await this.prisma.booking.findUniqueOrThrow({
      where: { id: d.bookingId },
      select: { id: true, reference: true, status: true, currency: true, totalMinor: true, departureDate: true, returnDate: true, createdAt: true, customerId: true, packageId: true },
    });
    const c = await this.prisma.customer.findUnique({ where: { id: booking.customerId }, select: { givenName: true, familyName: true, email: true, anonymisedAt: true } });
    const erased = !c || c.anonymisedAt !== null;
    const customer = c ? { name: `${c.givenName} ${c.familyName}`.trim(), email: c.email } : null;
    const pkg = await this.prisma.package.findUnique({ where: { id: booking.packageId }, select: { name: true } });
    const terms = await this.prisma.termsAcceptance.findMany({ where: { bookingId: d.bookingId }, orderBy: { acceptedAt: 'asc' }, select: { documentSlug: true, locale: true, contentVersion: true, textDigest: true, title: true, intro: true, body: true, acceptedAt: true } });
    const snapshots = await this.prisma.bookingSnapshot.findMany({ where: { bookingId: d.bookingId }, orderBy: { version: 'asc' }, select: { version: true, kind: true, createdAt: true, configuration: true, priceBreakdown: true, totalMinor: true, depositMinor: true, currency: true } });
    const payments = await this.prisma.payment.findMany({ where: { bookingId: d.bookingId, status: { in: ['succeeded', 'voided'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, method: true, amountMinor: true, currency: true, status: true, succeededAt: true, providerPaymentRef: true } });
    const refunds = await this.prisma.refund.findMany({ where: { bookingId: d.bookingId }, orderBy: { createdAt: 'asc' }, select: { paymentId: true, amountMinor: true, currency: true, status: true, origin: true, createdAt: true, succeededAt: true } });
    const emails = await this.prisma.outboundEmail.findMany({
      // Review of the code, L1: only the emails about this booking, never those of the customer's other bookings.
      where: { relatedEntityType: 'Booking', relatedEntityId: d.bookingId }, orderBy: { createdAt: 'asc' }, take: 500,
      select: { templateKey: true, subject: true, to: true, status: true, sentAt: true, createdAt: true, bodySha256: true },
    });
    const history = await this.prisma.auditLog.findMany({ where: { entityType: 'Booking', entityId: d.bookingId, action: 'bookings.booking.status_changed' }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true, changes: true } });
    const money = (v: bigint) => v.toString();
    const names = (pkg?.name ?? null) as Record<string, string> | null;
    const pkgName = names && typeof names === 'object' ? names['en-AU'] ?? Object.values(names)[0] ?? null : null;
    const pack = {
      generatedAt: new Date().toISOString(),
      dispute: { gatewayReference: d.providerDisputeRef, reasonCode: d.reasonCode, status: d.status, amountMinor: money(d.amountMinor), currency: d.currency, evidenceDueBy: d.evidenceDueBy?.toISOString() ?? null },
      booking: {
        reference: booking.reference, status: booking.status, package: pkgName, departureDate: booking.departureDate?.toISOString().slice(0, 10) ?? null, returnDate: booking.returnDate?.toISOString().slice(0, 10) ?? null,
        requestedAt: booking.createdAt.toISOString(), totalMinor: money(booking.totalMinor), currency: booking.currency,
        statusHistory: history.map((h) => {
          const ctx = ((h.changes as Record<string, unknown> | null)?._context ?? {}) as Record<string, unknown>;
          return { at: h.occurredAt.toISOString(), from: ctx.from ?? null, to: ctx.to ?? null };
        }),
      },
      customer: erased ? { erased: true } : { erased: false, name: customer?.name ?? null, email: customer?.email ?? null },
      termsAccepted: terms.map((t) => ({ ...t, acceptedAt: t.acceptedAt.toISOString() })),
      configurationAndPrice: snapshots.map((s) => ({ ...s, totalMinor: money(s.totalMinor), depositMinor: money(s.depositMinor), createdAt: s.createdAt.toISOString() })),
      payments: payments.map((p) => ({ ...p, amountMinor: money(p.amountMinor), succeededAt: p.succeededAt?.toISOString() ?? null, disputed: p.id === d.paymentId })),
      refunds: refunds.map((r) => ({ ...r, amountMinor: money(r.amountMinor), createdAt: r.createdAt.toISOString(), succeededAt: r.succeededAt?.toISOString() ?? null })),
      // Email bodies are never stored (task 0.4): each email is listed with the fingerprint of what was sent.
      emailsSent: emails.map((e) => ({ template: e.templateKey, subject: erased ? null : e.subject, to: erased ? null : e.to, status: e.status, sentAt: e.sentAt?.toISOString() ?? null, queuedAt: e.createdAt.toISOString(), bodySha256: e.bodySha256 })),
      summary: [
        `Booking ${booking.reference} was requested on ${booking.createdAt.toISOString().slice(0, 10)}${pkgName ? ` for ${pkgName}` : ''}.`,
        ...terms.map((t) => `The customer accepted "${t.title}" (version ${t.contentVersion}) on ${t.acceptedAt.toISOString().slice(0, 10)}.`),
        `The disputed payment is ${money(d.amountMinor)} minor units of ${d.currency}.`,
        `${emails.filter((e) => e.status === 'sent').length} emails about this booking were sent to the customer.`,
      ],
    };
    const body = JSON.stringify(pack, null, 2);
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actor, action: 'payments.dispute.evidence_downloaded', entityType: 'Dispute', entityId: d.id, context: { bookingId: d.bookingId, sha256: sha256Hex(body) } }));
    return { filename: `dispute-${d.providerDisputeRef.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-evidence.json`, body };
  }
}
