import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { AppError } from '../../../platform/errors/safe-error';
import { allocate } from './allocation';
import { CUSTOMER_ACCOUNTS, LEDGER_ACCOUNTS, LedgerLine, accountKind, assertBalanced, contentSha256, customerSide } from './ledger';
import { netCollectedSource } from './payable';

type Tx = Prisma.TransactionClient;
type Mode = 'test' | 'live';
type Kind = 'payment' | 'refund' | 'chargeback' | 'adjustment' | 'reversal';

/** A key already posted with other content: never a second or different posting (plan 3.3, section 1.3). */
export class LedgerKeyConflictError extends AppError {
  constructor() {
    super('ledger_key_conflict', 'A ledger posting with this key already exists with other content');
  }
}

interface BookingRef {
  id: string;
  currency: string;
}

interface Posting {
  key: string;
  kind: Kind;
  mode: Mode;
  description: string;
  paymentId?: string;
  refundId?: string;
  disputeId?: string;
  /** For a reversal: the key of the posting it reverses. */
  reversesKey?: string;
  /** The cash side: an account and what moves in (+) or out (−). None for a reallocation. */
  cash?: { accountCode: string; amountMinor: bigint };
}

/**
 * The only code that writes the ledger (plan 3.3, section 1.2; checked by a test). Every caller holds the booking's lock
 * (lock order Booking → Payment → Refund), so two postings of one booking never interleave and the balances it reads are
 * current. The customer side is the allocation after the fact minus what the ledger holds (plan 3.3, 12.7).
 */
@Injectable()
export class LedgerService {
  /** Money in for a payment that just succeeded (any origin): `payment:<id>:succeeded`. */
  postPaymentSucceeded(tx: Tx, booking: BookingRef, p: { id: string; providerAccountId: string; amountMinor: bigint; mode: Mode }): Promise<string | null> {
    return this.post(tx, booking, {
      key: `payment:${p.id}:succeeded`, kind: 'payment', mode: p.mode, description: 'payment_succeeded', paymentId: p.id,
      cash: { accountCode: LEDGER_ACCOUNTS.clearing(p.providerAccountId), amountMinor: p.amountMinor },
    });
  }

  /** Money out for a refund that just succeeded: `refund:<id>:succeeded`. */
  postRefundSucceeded(tx: Tx, booking: BookingRef, r: { id: string; paymentId: string; providerAccountId: string; amountMinor: bigint; mode: Mode }): Promise<string | null> {
    return this.post(tx, booking, {
      key: `refund:${r.id}:succeeded`, kind: 'refund', mode: r.mode, description: 'refund_succeeded', refundId: r.id,
      cash: { accountCode: LEDGER_ACCOUNTS.clearing(r.providerAccountId), amountMinor: -r.amountMinor },
    });
  }

  /** A refund the gateway reversed after its success: the money is back. `refund:<id>:reversed`, a reversal of its posting. */
  postRefundReversed(tx: Tx, booking: BookingRef, r: { id: string; providerAccountId: string; amountMinor: bigint; mode: Mode }): Promise<string | null> {
    return this.post(tx, booking, {
      key: `refund:${r.id}:reversed`, kind: 'reversal', mode: r.mode, description: 'refund_reversed', refundId: r.id, reversesKey: `refund:${r.id}:succeeded`,
      cash: { accountCode: LEDGER_ACCOUNTS.clearing(r.providerAccountId), amountMinor: r.amountMinor },
    });
  }

  /**
   * An inbound transfer confirmed by mistake and voided (task 3.4): `inbound:<id>:voided`, a reversal of its payment
   * posting, cash line mirrored exactly, customer side recomputed (plan 3.3, 12.8). Called by 3.4's onVoided hook.
   */
  postInboundVoided(tx: Tx, booking: BookingRef, p: { id: string; providerAccountId: string; amountMinor: bigint; mode: Mode }): Promise<string | null> {
    return this.post(tx, booking, {
      key: `inbound:${p.id}:voided`, kind: 'reversal', mode: p.mode, description: 'inbound_voided', paymentId: p.id, reversesKey: `payment:${p.id}:succeeded`,
      cash: { accountCode: LEDGER_ACCOUNTS.clearing(p.providerAccountId), amountMinor: -p.amountMinor },
    });
  }

  /**
   * The gateway took a disputed amount from us (task 4.5): `chargeback:<disputeId>:withdrawn`. The customer side is
   * recomputed, so it comes off the overpayment, then the last items, then becomes a receivable.
   */
  postChargebackWithdrawn(tx: Tx, booking: BookingRef, d: { id: string; providerAccountId: string; amountMinor: bigint; mode: Mode }): Promise<string | null> {
    return this.post(tx, booking, {
      key: `chargeback:${d.id}:withdrawn`, kind: 'chargeback', mode: d.mode, description: 'chargeback_withdrawn', disputeId: d.id,
      cash: { accountCode: LEDGER_ACCOUNTS.clearing(d.providerAccountId), amountMinor: -d.amountMinor },
    });
  }

  /** The gateway gave a disputed amount back: `chargeback:<disputeId>:reinstated`, a reversal of the withdrawal. */
  postChargebackReinstated(tx: Tx, booking: BookingRef, d: { id: string; providerAccountId: string; amountMinor: bigint; mode: Mode }): Promise<string | null> {
    return this.post(tx, booking, {
      key: `chargeback:${d.id}:reinstated`, kind: 'reversal', mode: d.mode, description: 'chargeback_reinstated', disputeId: d.id, reversesKey: `chargeback:${d.id}:withdrawn`,
      cash: { accountCode: LEDGER_ACCOUNTS.clearing(d.providerAccountId), amountMinor: d.amountMinor },
    });
  }

  /** The plan changed (approval, expiry, cancellation, amendment): funds and overpayments follow it. Nothing if no change. */
  reallocate(tx: Tx, booking: BookingRef, mode: Mode, key: string): Promise<string | null> {
    return this.post(tx, booking, { key, kind: 'adjustment', mode, description: 'reallocation' });
  }

  /** What the ledger holds for a booking in its customer accounts (liabilities as positive). */
  async customerBalances(tx: Tx, bookingId: string, currency: string, mode: Mode): Promise<{ fundsMinor: bigint; overpaymentsMinor: bigint; receivableMinor: bigint }> {
    const rows = await tx.$queryRaw<Array<{ code: string; total: bigint }>>`
      SELECT "accountCode" AS code, COALESCE(SUM("amountMinor"), 0)::bigint AS total FROM ledger_entries
      WHERE "bookingId" = ${bookingId}::uuid AND currency = ${currency} AND mode = ${mode}::"PaymentMode" AND "accountCode" = ANY(${[...CUSTOMER_ACCOUNTS]}::text[])
      GROUP BY "accountCode"`;
    const of = (code: string) => rows.find((r) => r.code === code)?.total ?? 0n;
    return { fundsMinor: -of(LEDGER_ACCOUNTS.funds), overpaymentsMinor: -of(LEDGER_ACCOUNTS.overpayments), receivableMinor: of(LEDGER_ACCOUNTS.receivable) };
  }

  private async post(tx: Tx, booking: BookingRef, p: Posting): Promise<string | null> {
    const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: booking.id, state: 'active' }, select: { sequence: true, amountMinor: true } });
    const target = allocate(items, await netCollectedSource.collected(tx, booking.id, p.mode));
    const balances = await this.customerBalances(tx, booking.id, booking.currency, p.mode);
    const cashIn = p.cash?.amountMinor ?? 0n;
    const lines: LedgerLine[] = [
      ...(p.cash && cashIn !== 0n ? [{ accountCode: p.cash.accountCode, amountMinor: cashIn }] : []),
      ...customerSide({ fundsMinor: target.items.reduce((s, i) => s + i.paidMinor, 0n), overpaymentsMinor: target.overpaidMinor, receivableMinor: -target.receivableMinor }, balances, cashIn),
    ];
    // A reallocation with nothing to move posts nothing.
    if (!p.cash && lines.length === 0) return null;
    assertBalanced(lines);

    let reversesId: string | null = null;
    if (p.reversesKey) {
      const original = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM ledger_transactions WHERE "idempotencyKey" = ${p.reversesKey}`;
      if (!original[0]) throw new AppError('ledger_reversal_without_original', 'There is no posting to reverse');
      reversesId = original[0].id;
    }
    const sha = contentSha256({
      kind: p.kind, mode: p.mode, currency: booking.currency, bookingId: booking.id, paymentId: p.paymentId ?? null, refundId: p.refundId ?? null,
      disputeId: p.disputeId ?? null, reversesTransactionId: reversesId, description: p.description, lines,
    });
    for (const l of lines) {
      await tx.$executeRaw`
        INSERT INTO ledger_accounts (id, code, kind, currency, mode) VALUES (gen_random_uuid(), ${l.accountCode}, ${accountKind(l.accountCode)}::"LedgerAccountKind", ${booking.currency}, ${p.mode}::"PaymentMode")
        ON CONFLICT (code, currency, mode) DO NOTHING`;
    }
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO ledger_transactions (id, kind, mode, "bookingId", "paymentId", "refundId", "disputeId", "reversesTransactionId", "idempotencyKey", description, "contentSha256")
      VALUES (gen_random_uuid(), ${p.kind}::"LedgerTransactionKind", ${p.mode}::"PaymentMode", ${booking.id}::uuid, ${p.paymentId ?? null}::uuid, ${p.refundId ?? null}::uuid,
              ${p.disputeId ?? null}::uuid, ${reversesId}::uuid, ${p.key}, ${p.description}, ${sha})
      ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING id::text AS id`;
    if (!inserted[0]) {
      const existing = await tx.$queryRaw<Array<{ id: string; contentSha256: string }>>`SELECT id::text AS id, "contentSha256" FROM ledger_transactions WHERE "idempotencyKey" = ${p.key}`;
      if (existing[0]?.contentSha256 === sha) return existing[0].id;
      throw new LedgerKeyConflictError();
    }
    const txId = inserted[0].id;
    for (const l of lines) {
      await tx.$executeRaw`
        INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor", "bookingId")
        VALUES (gen_random_uuid(), ${txId}::uuid, ${p.mode}::"PaymentMode", ${l.accountCode}, ${booking.currency}, ${l.amountMinor}, ${booking.id}::uuid)`;
    }
    return txId;
  }
}
