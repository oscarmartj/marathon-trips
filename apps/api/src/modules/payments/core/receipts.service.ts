// Receipts and notes (plan docs/plans/4.6-reconciliation-receipts.md, section 4 and review R7, R12). One document per
// ledger posting: a receipt for each payment collected, a note for each refund, refund reversal, chargeback,
// reinstatement and void. Issued once (the posting's key is unique among documents), numbered in one series per mode
// with no gaps (the number is taken in the same transaction as the document), never changed. GST registration cannot be
// switched on in 4.6: no document shows GST or the words "tax invoice".
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { brand } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import type { AppConfig } from '../../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { AppError } from '../../../platform/errors/safe-error';
import type { DeliveredEvent } from '../../../platform/events/consumers';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { NumberSequenceService } from '../../../platform/sequences/number-sequence.service';
import { readBookingForPayments, todayInBrisbane } from '../../bookings';
import { buildPdf } from '../../templates';
import { PAYMENT_EVENTS } from './attempt-state';
import { LEDGER_ACCOUNTS } from './ledger';
import { PAYMENT_TX_OPTIONS } from './payable-states';

type Tx = Prisma.TransactionClient;
type Mode = 'test' | 'live';

/** The fixed layout every document is printed with (plan 4.6, D11): never the editable template of 5.4. */
export const RECEIPT_LAYOUT_VERSION = 1;

export type NoteKind = 'refund' | 'refund_reversal' | 'chargeback' | 'chargeback_reinstatement' | 'void';

/** What a ledger posting's key says the document is. Null: no document for that posting. */
export type DocumentCause =
  | { doc: 'receipt'; paymentId: string }
  | { doc: 'note'; kind: NoteKind; refundId?: string; disputeId?: string; paymentId?: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^(payment|refund|chargeback|inbound):(${UUID}):(succeeded|reversed|withdrawn|reinstated|voided)$`);

export function causeOf(key: string): DocumentCause | null {
  const m = KEY.exec(key);
  if (!m) return null;
  const [, what, id, fact] = m as unknown as [string, string, string, string];
  if (what === 'payment' && fact === 'succeeded') return { doc: 'receipt', paymentId: id };
  if (what === 'refund' && fact === 'succeeded') return { doc: 'note', kind: 'refund', refundId: id };
  if (what === 'refund' && fact === 'reversed') return { doc: 'note', kind: 'refund_reversal', refundId: id };
  if (what === 'chargeback' && fact === 'withdrawn') return { doc: 'note', kind: 'chargeback', disputeId: id };
  if (what === 'chargeback' && fact === 'reinstated') return { doc: 'note', kind: 'chargeback_reinstatement', disputeId: id };
  if (what === 'inbound' && fact === 'voided') return { doc: 'note', kind: 'void', paymentId: id };
  return null;
}

/** The posting key a payments event leads to (the consumer issues its document). */
export function causeKeyOfEvent(e: Pick<DeliveredEvent, 'type' | 'aggregateId'>): string | null {
  switch (e.type) {
    case PAYMENT_EVENTS.succeeded: return `payment:${e.aggregateId}:succeeded`;
    case PAYMENT_EVENTS.voided: return `inbound:${e.aggregateId}:voided`;
    case PAYMENT_EVENTS.refundSucceeded: return `refund:${e.aggregateId}:succeeded`;
    case PAYMENT_EVENTS.refundReversed: return `refund:${e.aggregateId}:reversed`;
    case PAYMENT_EVENTS.chargebackWithdrawn: return `chargeback:${e.aggregateId}:withdrawn`;
    case PAYMENT_EVENTS.chargebackReinstated: return `chargeback:${e.aggregateId}:reinstated`;
    default: return null;
  }
}

export const RECEIPT_EVENTS: readonly string[] = [PAYMENT_EVENTS.succeeded, PAYMENT_EVENTS.voided, PAYMENT_EVENTS.refundSucceeded, PAYMENT_EVENTS.refundReversed, PAYMENT_EVENTS.chargebackWithdrawn, PAYMENT_EVENTS.chargebackReinstated];

/** Without GST registration (always, in 4.6): plain titles, never "tax invoice" (ATO: plan 4.6, section 5.1). */
export const DOCUMENT_TITLES: Readonly<Record<'receipt' | NoteKind, string>> = {
  receipt: 'Receipt',
  refund: 'Refund note',
  refund_reversal: 'Refund reversal note',
  chargeback: 'Chargeback note',
  chargeback_reinstatement: 'Chargeback reversal note',
  void: 'Receipt voided',
};

const METHOD_WORDS: Readonly<Record<string, string>> = { card: 'card', apple_pay: 'Apple Pay', google_pay: 'Google Pay', payid_transfer: 'bank transfer', bank_transfer: 'bank transfer', payto: 'PayTo', becs: 'direct debit', bpay: 'BPAY', bnpl: 'pay later', manual_other: 'other' };

/** 123456 in AUD is "A$1,234.56". Formats a stored amount; computes nothing. */
export function formatAmount(minor: bigint, currency: string): string {
  const abs = minor < 0n ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0n ? '-' : ''}${currency === 'AUD' ? 'A$' : `${currency} `}${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** What is printed, and nothing else: no customer name, email or address; no card digits or bank details. */
export interface DocumentContent {
  title: string;
  number: string;
  issuedOn: string;
  issuer: string;
  bookingReference: string;
  trip: string;
  description: string;
  method: string;
  amount: string;
  amountMinor: string;
  currency: string;
  /** For a note: the receipt it is about. */
  receiptNumber?: string;
  footer: string;
}

// ATO: a business not registered for GST does not use the words "tax invoice" (plan 4.6, section 5.1), not even to deny them.
const FOOTER_PLAIN = 'A record of money received or returned for the booking above.';

/** SHA-256 of the content with its keys sorted (the database keeps JSON in its own key order). */
export const contentSha256 = (c: DocumentContent): string => createHash('sha256').update(JSON.stringify(c, Object.keys(c).sort())).digest('hex');

/** The document's PDF, rebuilt from its stored content with the fixed layout (the same bytes every time). */
export function renderDocument(c: DocumentContent): Buffer {
  const lines = [
    `Number: ${c.number}`,
    `Date: ${c.issuedOn}`,
    `Issued by: ${c.issuer}`,
    ...(c.receiptNumber ? [`About receipt: ${c.receiptNumber}`] : []),
    '',
    `Booking reference: ${c.bookingReference}`,
    `Trip: ${c.trip}`,
    '',
    c.description,
    `Method: ${c.method}`,
    `Amount: ${c.amount}`,
    '',
    c.footer,
  ];
  return buildPdf({ title: c.title, body: lines.join('\n') });
}

const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};

export interface DocumentView {
  number: string;
  kind: 'receipt' | NoteKind;
  title: string;
  issuedAt: Date;
  amountMinor: string;
  currency: string;
  receiptNumber: string | null;
}

@Injectable()
export class ReceiptsService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PaymentsReceipts');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NumberSequenceService) private readonly sequences: NumberSequenceService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.paymentsReceipts, async () => void (await this.sweep()));
    await this.jobs.schedule(QUEUES.paymentsReceipts, '17 * * * *');
  }

  /** The outbox consumer (payments.receipts): the event's posting gets its document, in the delivery's transaction. */
  async onEvent(e: DeliveredEvent, tx: Tx): Promise<void> {
    const key = causeKeyOfEvent(e);
    if (key) await this.issueIn(tx, key);
  }

  /**
   * Issues the document of one ledger posting, if it has none yet, in the caller's transaction. Locks the booking first
   * (lock order Booking → number sequence), so two deliveries of one event never both take a number. A posting that does
   * not exist (yet) issues nothing: the hourly sweep finds it later. Returns the document's number, or null.
   */
  async issueIn(tx: Tx, key: string): Promise<string | null> {
    const cause = causeOf(key);
    if (!cause) return null;
    const [posting] = await tx.$queryRaw<Array<{ id: string; bookingId: string; mode: Mode; createdTxId: bigint }>>`
      SELECT id::text AS id, "bookingId"::text AS "bookingId", mode::text AS mode, "createdTxId" FROM ledger_transactions WHERE "idempotencyKey" = ${key}`;
    if (!posting) return null;
    const b = await readBookingForPayments(tx, { id: posting.bookingId }, true);
    if (!b) return null;
    const existing = await this.numberOf(tx, key);
    if (existing) return existing;
    const funds = await this.fundsAfter(tx, posting.bookingId, b.currency, posting.mode, posting.createdTxId);
    if (cause.doc === 'receipt') return this.insertReceipt(tx, key, cause.paymentId, funds);
    return this.insertNote(tx, key, cause, posting.mode, funds);
  }

  private async numberOf(tx: Tx, key: string): Promise<string | null> {
    const r = await tx.receipt.findUnique({ where: { causeKey: key }, select: { number: true } });
    if (r) return r.number;
    const n = await tx.receiptNote.findUnique({ where: { causeKey: key }, select: { number: true } });
    return n?.number ?? null;
  }

  /**
   * customer_funds of the booking after the posting (review R6: the base GST will use once registration exists): the
   * postings of the booking up to this one, in the order their transactions started (they run under the booking's lock).
   */
  private async fundsAfter(tx: Tx, bookingId: string, currency: string, mode: Mode, createdTxId: bigint): Promise<bigint> {
    const [row] = await tx.$queryRaw<Array<{ funds: bigint }>>`
      SELECT COALESCE(-SUM(e."amountMinor"), 0)::bigint AS funds FROM ledger_entries e JOIN ledger_transactions t ON t.id = e."transactionId"
      WHERE e."bookingId" = ${bookingId}::uuid AND e.mode = ${mode}::"PaymentMode" AND e.currency = ${currency} AND e."accountCode" = ${LEDGER_ACCOUNTS.funds}
        AND t."createdTxId" <= ${createdTxId}`;
    const f = row?.funds ?? 0n;
    return f < 0n ? 0n : f;
  }

  private async takeNumber(tx: Tx, mode: Mode, kind: 'receipt' | 'note'): Promise<string> {
    const { formatted } = await this.sequences.next(tx, `receipts:${mode}`);
    await tx.receiptNumber.create({ data: { number: formatted, mode, kind } });
    return formatted;
  }

  private async tripOf(tx: Tx, bookingId: string): Promise<{ reference: string; trip: string }> {
    const b = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { reference: true, package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } } },
    });
    return { reference: b.reference, trip: `${en(b.package.edition.race.name)} ${b.package.edition.year}: ${en(b.package.name)}` };
  }

  private async insertReceipt(tx: Tx, key: string, paymentId: string, funds: bigint): Promise<string> {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { id: true, bookingId: true, mode: true, currency: true, amountMinor: true, method: true, origin: true, succeededAt: true } });
    const number = await this.takeNumber(tx, p.mode, 'receipt');
    const { reference, trip } = await this.tripOf(tx, p.bookingId);
    const content: DocumentContent = {
      title: DOCUMENT_TITLES.receipt, number, issuedOn: todayInBrisbane(new Date()), issuer: brand.name, bookingReference: reference, trip,
      description: `Payment received for booking ${reference}`, method: METHOD_WORDS[p.method] ?? 'other',
      amount: formatAmount(p.amountMinor, p.currency), amountMinor: p.amountMinor.toString(), currency: p.currency, footer: FOOTER_PLAIN,
    };
    await tx.receipt.create({
      data: {
        number, bookingId: p.bookingId, paymentId: p.id, mode: p.mode, currency: p.currency, amountMinor: p.amountMinor, causeKey: key, fundsAfterMinor: funds,
        content: content as unknown as Prisma.InputJsonValue, layoutVersion: RECEIPT_LAYOUT_VERSION, contentSha256: contentSha256(content),
      },
    });
    return number;
  }

  private async insertNote(tx: Tx, key: string, cause: Extract<DocumentCause, { doc: 'note' }>, mode: Mode, funds: bigint): Promise<string | null> {
    let paymentId: string;
    let amountMinor: bigint;
    if (cause.refundId) {
      const r = await tx.refund.findUniqueOrThrow({ where: { id: cause.refundId }, select: { paymentId: true, amountMinor: true } });
      paymentId = r.paymentId;
      amountMinor = r.amountMinor;
    } else if (cause.disputeId) {
      const d = await tx.dispute.findUniqueOrThrow({ where: { id: cause.disputeId }, select: { paymentId: true, amountMinor: true } });
      paymentId = d.paymentId;
      amountMinor = d.amountMinor;
    } else {
      const p = await tx.payment.findUniqueOrThrow({ where: { id: cause.paymentId! }, select: { id: true, amountMinor: true } });
      paymentId = p.id;
      amountMinor = p.amountMinor;
    }
    // The note is about the payment's receipt: issued first if it was not yet (same transaction, same lock).
    let receipt = await tx.receipt.findUnique({ where: { paymentId }, select: { id: true, number: true, bookingId: true, currency: true, mode: true } });
    if (!receipt) {
      await this.issueIn(tx, `payment:${paymentId}:succeeded`);
      receipt = await tx.receipt.findUnique({ where: { paymentId }, select: { id: true, number: true, bookingId: true, currency: true, mode: true } });
    }
    if (!receipt) throw new AppError('receipt_missing_for_note', 'The payment of this note has no receipt yet');
    const number = await this.takeNumber(tx, mode, 'note');
    const { reference, trip } = await this.tripOf(tx, receipt.bookingId);
    const decrease = cause.kind === 'refund' || cause.kind === 'chargeback' || cause.kind === 'void';
    const words: Record<NoteKind, string> = {
      refund: `Refund for booking ${reference}`,
      refund_reversal: `Refund reversed by the payment provider for booking ${reference}`,
      chargeback: `Payment taken back by the card issuer for booking ${reference}`,
      chargeback_reinstatement: `Payment returned by the card issuer for booking ${reference}`,
      void: `Receipt ${receipt.number} is voided: the bank transfer was recorded by mistake`,
    };
    const content: DocumentContent = {
      title: DOCUMENT_TITLES[cause.kind], number, issuedOn: todayInBrisbane(new Date()), issuer: brand.name, bookingReference: reference, trip,
      description: words[cause.kind], method: cause.kind === 'void' ? 'bank transfer' : 'as the original payment',
      amount: formatAmount(decrease ? -amountMinor : amountMinor, receipt.currency), amountMinor: amountMinor.toString(), currency: receipt.currency,
      receiptNumber: receipt.number, footer: FOOTER_PLAIN,
    };
    await tx.receiptNote.create({
      data: {
        number, kind: cause.kind, direction: decrease ? 'decrease' : 'increase', receiptId: receipt.id, bookingId: receipt.bookingId, mode: receipt.mode, currency: receipt.currency,
        amountMinor, refundId: cause.refundId ?? null, disputeId: cause.disputeId ?? null, causeKey: key, fundsAfterMinor: funds,
        content: content as unknown as Prisma.InputJsonValue, layoutVersion: RECEIPT_LAYOUT_VERSION, contentSha256: contentSha256(content),
      },
    });
    return number;
  }

  /** Postings of the environment's mode that should have a document and have none (oldest first). */
  async missingKeys(opts: { olderThan?: Date; bookingIds?: string[]; limit?: number } = {}): Promise<string[]> {
    const mode = this.mode;
    const before = opts.olderThan ?? new Date();
    const only = opts.bookingIds ?? null;
    const rows = await this.prisma.$queryRaw<Array<{ key: string }>>`
      SELECT t."idempotencyKey" AS key FROM ledger_transactions t
      WHERE t.mode = ${mode}::"PaymentMode" AND t."occurredAt" < ${before}
        AND t."idempotencyKey" ~ '^(payment:[0-9a-f-]{36}:succeeded|refund:[0-9a-f-]{36}:(succeeded|reversed)|chargeback:[0-9a-f-]{36}:(withdrawn|reinstated)|inbound:[0-9a-f-]{36}:voided)$'
        AND (${only}::uuid[] IS NULL OR t."bookingId" = ANY(${only}::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r."causeKey" = t."idempotencyKey")
        AND NOT EXISTS (SELECT 1 FROM receipt_notes n WHERE n."causeKey" = t."idempotencyKey")
      ORDER BY t."occurredAt", t.id LIMIT ${opts.limit ?? 500}`;
    return rows.map((r) => r.key);
  }

  /** The hourly safety net (review R12 c): one transaction per document, so it never holds two bookings' locks. */
  async sweep(opts: { bookingIds?: string[] } = {}): Promise<number> {
    let issued = 0;
    for (const key of await this.missingKeys({ ...opts, olderThan: new Date() })) {
      try {
        const n = await runTransaction(this.prisma, (tx) => this.issueIn(tx, key), PAYMENT_TX_OPTIONS);
        if (n) issued += 1;
      } catch (err) {
        this.logger.warn(`receipt sweep: ${key.split(":")[0]} posting not issued (${(err as { code?: string }).code ?? "error"})`);
      }
    }
    return issued;
  }

  private get mode(): Mode {
    return this.config.APP_ENV === 'production' ? 'live' : 'test';
  }

  /** The documents of a booking, oldest first (staff and its owner). */
  async listForBooking(bookingId: string): Promise<DocumentView[]> {
    const [receipts, notes] = await Promise.all([
      this.prisma.receipt.findMany({ where: { bookingId, mode: this.mode }, select: { number: true, issuedAt: true, amountMinor: true, currency: true } }),
      this.prisma.receiptNote.findMany({ where: { bookingId, mode: this.mode }, select: { number: true, kind: true, issuedAt: true, amountMinor: true, currency: true, receipt: { select: { number: true } } } }),
    ]);
    const all: DocumentView[] = [
      ...receipts.map((r) => ({ number: r.number, kind: 'receipt' as const, title: DOCUMENT_TITLES.receipt, issuedAt: r.issuedAt, amountMinor: r.amountMinor.toString(), currency: r.currency, receiptNumber: null })),
      ...notes.map((n) => ({ number: n.number, kind: n.kind, title: DOCUMENT_TITLES[n.kind], issuedAt: n.issuedAt, amountMinor: n.amountMinor.toString(), currency: n.currency, receiptNumber: n.receipt.number })),
    ];
    return all.sort((a, b) => Number(BigInt(a.number.slice(5)) - BigInt(b.number.slice(5))));
  }

  /** One document's PDF, if it belongs to the booking (or to any booking when `bookingId` is null: staff). */
  async pdf(number: string, bookingIds: string[] | null): Promise<{ pdf: Buffer; filename: string } | null> {
    if (!/^MT-[TR]-[1-9][0-9]{0,17}$/.test(number)) return null;
    const r = await this.prisma.receipt.findUnique({ where: { number }, select: { bookingId: true, content: true, mode: true } });
    const doc = r ?? (await this.prisma.receiptNote.findUnique({ where: { number }, select: { bookingId: true, content: true, mode: true } }));
    if (!doc || doc.mode !== this.mode || (bookingIds && !bookingIds.includes(doc.bookingId))) return null;
    return { pdf: renderDocument(doc.content as unknown as DocumentContent), filename: `${number}.pdf` };
  }
}
