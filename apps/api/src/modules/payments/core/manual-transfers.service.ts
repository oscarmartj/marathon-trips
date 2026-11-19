import { Inject, Injectable } from '@nestjs/common';
import type { ConfirmTransfer, VoidTransfer } from '@mt/shared';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { conflict, notFound } from '../../../platform/http/api-error';
import { readBookingForPayments } from '../../bookings';
import { MANUAL_KEY } from '../adapters/manual/manual';
import { PaymentStateMachine, lockPayment } from './attempt-state';
import { PAYMENT_TX_OPTIONS, PaymentAttemptsService } from './attempts.service';
import { coverageFacts } from './allocation';
import { ProviderGateway, callBlockReason } from './gateway';
import { payable, succeededPaymentsSource } from './payable';
import { PAYABLE_STATES } from './payable-states';

/** The most a single transfer can be recorded for: A$1,000,000 in minor units (plan 0.1, 1.1). */
export const MAX_TRANSFER_MINOR = 100_000_000n;

/** Booking states that can take money confirmed from the bank (anything with a plan that is not refunded). */
const RECEIVING: readonly string[] = ['approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed', 'cancelled', 'expired'];
/** States whose own status stands on a covered deposit: Oscar confirmed it with that money. */
const NEEDS_DEPOSIT: readonly string[] = ['confirmed', 'balance_paid', 'completed'];

export interface TransferView {
  id: string;
  bookingId: string;
  status: string;
  method: string;
  amountMinor: string;
  currency: string;
  reference: string;
  version: number;
  succeededAt: string | null;
}

const SELECT = { id: true, bookingId: true, status: true, method: true, amountMinor: true, currency: true, providerPaymentRef: true, version: true, succeededAt: true } as const;
const toView = (p: { id: string; bookingId: string; status: string; method: string; amountMinor: bigint; currency: string; providerPaymentRef: string | null; version: number; succeededAt: Date | null }): TransferView => ({
  id: p.id, bookingId: p.bookingId, status: p.status, method: p.method, amountMinor: p.amountMinor.toString(), currency: p.currency, reference: p.providerPaymentRef ?? '', version: p.version, succeededAt: p.succeededAt?.toISOString() ?? null,
});

const isUnique = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
const referenceTaken = () => conflict('reference_already_recorded', 'This bank reference has already been recorded');

/**
 * Bank transfers confirmed by staff (task 3.4, plan sections 3 and 4). The amount is the bank's, typed by staff; the bank
 * movement's reference is the one reference of the transfer, unique per account until voided, and it is also what makes a
 * repeated confirmation harmless. Money goes through the same state machine and coverage rule as any other payment.
 */
@Injectable()
export class ManualTransfersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentStateMachine) private readonly machine: PaymentStateMachine,
    @Inject(PaymentAttemptsService) private readonly attempts: PaymentAttemptsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async confirm(bookingId: string, input: ConfirmTransfer, actor: AuditActor): Promise<{ transfer: TransferView; replayed: boolean }> {
    const amount = BigInt(input.amountMinor);
    if (amount <= 0n || amount > MAX_TRANSFER_MINOR) throw conflict('amount_out_of_range', 'The amount is outside what can be recorded');
    try {
      return await runTransaction(this.prisma, async (tx) => {
        const b = await readBookingForPayments(tx, { id: bookingId }, true);
        if (!b) throw notFound('booking_not_found', 'Booking not found');
        if (!RECEIVING.includes(b.status)) throw conflict('booking_cannot_receive_payment', 'This booking cannot take a payment in its current state');
        const accounts = await tx.providerAccount.findMany({ where: { adapterKey: MANUAL_KEY, status: 'active', mode: this.gateway.mode }, select: { id: true, adapterKey: true, mode: true, status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        const account = accounts.find((a) => callBlockReason(a, this.gateway.registry.get(a.adapterKey)?.manifest, 'create', this.gateway.env) === null);
        if (!account) throw conflict('no_manual_account', 'There is no bank transfer account set up for this environment');
        if (!this.gateway.registry.get(MANUAL_KEY)!.manifest.currencies.includes(b.currency)) throw conflict('currency_not_supported', 'Bank transfers are not available in this currency');

        const existing = await tx.payment.findFirst({ where: { providerAccountId: account.id, providerPaymentRef: input.reference, status: { not: 'voided' } }, select: { ...SELECT, origin: true } });
        if (existing) {
          // The same confirmation again: nothing is recorded twice (plan 3.4, section 3).
          if (existing.bookingId === b.id && existing.origin === 'inbound' && existing.amountMinor === amount) return { transfer: toView(existing), replayed: true };
          throw referenceTaken();
        }

        const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { id: true, sequence: true, amountMinor: true } });
        const collected = await succeededPaymentsSource.collected(tx, b.id, this.gateway.mode);
        const next = payable(items, collected).next;
        const target = next ? items.find((i) => i.sequence === next.sequence) : undefined;
        const last = await tx.payment.aggregate({ where: { bookingId: b.id }, _max: { attemptNumber: true } });
        const n = (last._max.attemptNumber ?? 0) + 1;
        const [{ at }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at` as [{ at: Date }];

        // The customer's open request to pay by transfer is answered by this money (plan 3.4, section 3, step 4).
        const open = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM payments WHERE "bookingId" = ${b.id}::uuid AND origin = 'manual_intent' AND status = 'created' FOR UPDATE`;
        for (const o of open) {
          const intent = await lockPayment(tx, b, o.id);
          if (intent) await this.machine.apply(tx, b, intent, 'cancelled', { source: 'api' });
        }

        const created = await tx.payment.create({
          data: {
            bookingId: b.id, currency: b.currency, origin: 'inbound', attemptNumber: n, targetScheduleItemId: target?.id ?? null, payerCustomerId: b.customerId,
            providerAccountId: account.id, mode: account.mode, adapterKey: account.adapterKey, method: input.method, amountMinor: amount, status: 'created',
            idempotencyKey: `booking:${b.id}:inbound:${n}`, providerPaymentRef: input.reference, payerReference: b.reference, pendingExpiresAt: at,
          },
          select: { id: true },
        });
        const p = await lockPayment(tx, b, created.id);
        if (!p) throw notFound();
        await this.machine.apply(tx, b, p, 'succeeded', { source: 'api' });
        await this.audit.record(tx, {
          actor, action: 'payments.transfer.confirmed', entityType: 'Payment', entityId: created.id, model: 'Payment',
          after: { status: 'succeeded', method: input.method, amountMinor: amount.toString(), currency: b.currency, providerPaymentRef: input.reference, payerReference: b.reference },
          context: { bookingId: b.id, attemptNumber: n },
        });
        const row = await tx.payment.findUniqueOrThrow({ where: { id: created.id }, select: SELECT });
        return { transfer: toView(row), replayed: false };
      }, PAYMENT_TX_OPTIONS);
    } catch (err) {
      // Another booking took this bank reference between our look and our insert.
      if (isUnique(err)) throw referenceTaken();
      throw await this.attempts.afterCoverageFailure(err);
    }
  }

  async void(paymentId: string, input: VoidTransfer, actor: AuditActor): Promise<TransferView> {
    const row = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { bookingId: true } });
    if (!row) throw notFound('payment_not_found', 'Payment not found');
    try {
      return await runTransaction(this.prisma, async (tx) => {
        const b = await readBookingForPayments(tx, { id: row.bookingId }, true);
        if (!b) throw notFound('booking_not_found', 'Booking not found');
        const p = await lockPayment(tx, b, paymentId);
        if (!p) throw notFound('payment_not_found', 'Payment not found');
        if (p.origin !== 'inbound' || p.status !== 'succeeded') throw conflict('payment_not_voidable', 'Only a confirmed bank transfer can be voided');
        if (p.version !== input.version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
        if (!RECEIVING.includes(b.status)) throw conflict('booking_cannot_receive_payment', 'This booking cannot change its payments in its current state');
        // Oscar confirmed the booking on a covered deposit: taking that money back is a refund or a cancellation (4.5, 6.4).
        const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { kind: true, sequence: true, amountMinor: true } });
        const after = (await succeededPaymentsSource.collected(tx, b.id, p.mode)) - p.amountMinor;
        if (NEEDS_DEPOSIT.includes(b.status) && !coverageFacts(items, after).depositCovered) {
          throw conflict('void_would_uncover_confirmed_booking', 'This booking was confirmed on this payment. Refund or cancel it instead.');
        }
        await this.machine.apply(tx, b, p, 'void', { source: 'api' });
        await this.audit.record(tx, {
          actor, action: 'payments.transfer.voided', entityType: 'Payment', entityId: p.id, model: 'Payment',
          before: { status: 'succeeded', amountMinor: p.amountMinor.toString() }, after: { status: 'voided' }, reason: input.reason,
          context: { bookingId: b.id },
        });
        return toView(await tx.payment.findUniqueOrThrow({ where: { id: p.id }, select: SELECT }));
      }, PAYMENT_TX_OPTIONS);
    } catch (err) {
      throw await this.attempts.afterCoverageFailure(err);
    }
  }

  /**
   * The sweep of open requests to pay by transfer (plan 3.4, section 2): past their expiry, or for a booking that can no
   * longer take a payment, they end. No gateway is asked: there is none. Returns the ids closed.
   */
  async closeOpenIntents(now: Date = new Date()): Promise<string[]> {
    const due = await this.prisma.$queryRaw<Array<{ id: string; bookingId: string }>>`
      SELECT p.id::text AS id, p."bookingId"::text AS "bookingId" FROM payments p JOIN bookings b ON b.id = p."bookingId"
      WHERE p.origin = 'manual_intent' AND p.status = 'created' AND (p."pendingExpiresAt" <= ${now} OR b.status::text <> ALL(${[...PAYABLE_STATES]}::text[]))
      ORDER BY p."pendingExpiresAt", p.id LIMIT 200`;
    const closed: string[] = [];
    for (const d of due) {
      const done = await runTransaction(this.prisma, async (tx) => {
        const b = await readBookingForPayments(tx, { id: d.bookingId }, true);
        const p = b ? await lockPayment(tx, b, d.id) : null;
        if (!b || !p || p.status !== 'created') return false;
        const [{ at }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at` as [{ at: Date }];
        const expiry = await tx.payment.findUniqueOrThrow({ where: { id: p.id }, select: { pendingExpiresAt: true } });
        await this.machine.apply(tx, b, p, expiry.pendingExpiresAt.getTime() <= at.getTime() ? 'expire_confirmed' : 'cancelled', { source: 'sweep' });
        return true;
      }, PAYMENT_TX_OPTIONS);
      if (done) closed.push(d.id);
    }
    return closed;
  }
}
