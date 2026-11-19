import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import type { AppConfig } from '../../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { allocate } from './allocation';
import { ProviderGateway } from './gateway';
import { LEDGER_ACCOUNTS } from './ledger';
import { PAYMENT_SETTINGS } from './settings';
import { SettingsService } from '../../../platform/flags/flags.service';

export type LedgerFindingKind = 'missing_payment_posting' | 'missing_refund_posting' | 'missing_chargeback_posting' | 'booking_total' | 'booking_split' | 'clearing' | 'empty_transaction';

export interface LedgerFinding {
  kind: LedgerFindingKind;
  entityType: 'Payment' | 'Refund' | 'Dispute' | 'Booking' | 'ProviderAccount' | 'LedgerTransaction';
  entityId: string;
}

/** Bookings examined per run, in id order from where the last run stopped (a cursor that wraps round). */
export const MAX_BOOKINGS = 5000;
const LEDGER_CHECK_CURSOR = PAYMENT_SETTINGS.ledgerCheckCursor;

export interface LedgerCheckPage {
  findings: LedgerFinding[];
  /** The last booking examined when the page was full (the next run continues after it); null when it reached the end. */
  next: string | null;
}

/**
 * The internal ledger check (plan 3.3, section 4), daily at 03:40 Brisbane time. It reads everything in one REPEATABLE
 * READ, read-only transaction (plan 3.3, 12.9), so a payment recorded meanwhile never looks like a difference, then opens
 * one task per difference. It never fixes anything. Against the gateway's own records: task 4.6.
 */
@Injectable()
export class PaymentLedgerCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PaymentsLedger');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.paymentsLedger, async () => void (await this.run()));
    // 17:40 UTC is 03:40 in Brisbane (no daylight saving).
    await this.jobs.schedule(QUEUES.paymentsLedger, '40 17 * * *');
  }

  /**
   * Runs the check and opens a task per finding. Bookings are taken in id order from the stored cursor, MAX_BOOKINGS at a
   * time, so with many bookings every one is checked in turn. `bookingIds` and `limit` narrow it (tests).
   */
  async run(opts: { bookingIds?: string[]; limit?: number } = {}): Promise<LedgerFinding[]> {
    // A run narrowed to some bookings (tests) neither reads nor moves the cursor.
    const narrowed = !!opts.bookingIds;
    const after = narrowed ? '' : await this.settings.get<string>(LEDGER_CHECK_CURSOR.key, LEDGER_CHECK_CURSOR.fallback);
    const { findings, next } = await this.checkPage({ ...opts, after: after || null });
    for (const f of findings) {
      await this.prisma.$transaction((tx) => this.tasks.createSystemIn(tx, {
        title: `Payment ledger check: ${f.kind.replace(/_/g, ' ')}`,
        description: `The daily ledger check found a difference (${f.kind}) for ${f.entityType} ${f.entityId}. Nothing was changed; check the payments and the ledger.`,
        entityType: f.entityType, entityId: f.entityId, sourceRef: `payments:ledger_check:${f.kind}:${f.entityId}`,
      }));
    }
    // Only once every task exists (task 4.1, from 3.3's review): a run that fails half-way checks the same page again.
    if (!narrowed) await this.settings.set(LEDGER_CHECK_CURSOR.key, next ?? '');
    if (findings.length > 0) this.logger.warn(`ledger check: ${findings.length} finding(s)`);
    return findings;
  }

  /** The findings for the first page of bookings (tests narrow it to their own bookings). */
  async check(opts: { bookingIds?: string[] } = {}): Promise<LedgerFinding[]> {
    return (await this.checkPage(opts)).findings;
  }

  /** One page of the check, read in one consistent snapshot: bookings after `after`, at most `limit`. */
  checkPage(opts: { bookingIds?: string[]; after?: string | null; limit?: number } = {}): Promise<LedgerCheckPage> {
    const mode = this.gateway.mode;
    const only = opts.bookingIds ?? null;
    const after = opts.after ?? null;
    const limit = opts.limit ?? MAX_BOOKINGS;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const out: LedgerFinding[] = [];
      const missingPayments = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT p.id::text AS id FROM payments p
        WHERE p.status = 'succeeded' AND p.mode = ${mode}::"PaymentMode" AND (${only}::uuid[] IS NULL OR p."bookingId" = ANY(${only}::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t."idempotencyKey" = 'payment:' || p.id::text || ':succeeded')
        ORDER BY p.id`;
      for (const r of missingPayments) out.push({ kind: 'missing_payment_posting', entityType: 'Payment', entityId: r.id });
      const missingRefunds = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT r.id::text AS id FROM refunds r
        WHERE r.status IN ('succeeded', 'reversed') AND r.mode = ${mode}::"PaymentMode" AND (${only}::uuid[] IS NULL OR r."bookingId" = ANY(${only}::uuid[]))
          AND (NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t."idempotencyKey" = 'refund:' || r.id::text || ':succeeded')
               OR (r.status = 'reversed' AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t."idempotencyKey" = 'refund:' || r.id::text || ':reversed')))
        ORDER BY r.id`;
      for (const r of missingRefunds) out.push({ kind: 'missing_refund_posting', entityType: 'Refund', entityId: r.id });
      // Task 4.5: every chargeback recorded on a dispute has its posting.
      const missingChargebacks = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT d.id::text AS id FROM disputes d
        WHERE d.mode = ${mode}::"PaymentMode" AND (${only}::uuid[] IS NULL OR d."bookingId" = ANY(${only}::uuid[]))
          AND ((d."fundsWithdrawnAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t."idempotencyKey" = 'chargeback:' || d.id::text || ':withdrawn'))
               OR (d."fundsReinstatedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t."idempotencyKey" = 'chargeback:' || d.id::text || ':reinstated')))
        ORDER BY d.id`;
      for (const r of missingChargebacks) out.push({ kind: 'missing_chargeback_posting', entityType: 'Dispute', entityId: r.id });

      const bookings = await tx.$queryRaw<Array<{ id: string; currency: string; net: bigint; reserved: bigint; funds: bigint; over: bigint; receivable: bigint }>>`
        WITH money AS (
          SELECT b.id, b.currency,
            COALESCE((SELECT SUM(p."amountMinor") FROM payments p WHERE p."bookingId" = b.id AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded'), 0)::bigint
            - COALESCE((SELECT SUM(r."amountMinor") FROM refunds r WHERE r."bookingId" = b.id AND r.mode = ${mode}::"PaymentMode" AND r.status = 'succeeded'), 0)::bigint
            - COALESCE((SELECT SUM(d."amountMinor") FROM disputes d WHERE d."bookingId" = b.id AND d.mode = ${mode}::"PaymentMode" AND d."fundsWithdrawnAt" IS NOT NULL AND d."fundsReinstatedAt" IS NULL), 0)::bigint AS net,
            COALESCE((SELECT SUM(r."amountMinor") FROM refunds r WHERE r."bookingId" = b.id AND r.mode = ${mode}::"PaymentMode" AND r.origin = 'app' AND r.status IN ('requested', 'pending')), 0)::bigint AS reserved
          FROM bookings b
          WHERE (EXISTS (SELECT 1 FROM payments p WHERE p."bookingId" = b.id AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded')
                 OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e."bookingId" = b.id AND e.mode = ${mode}::"PaymentMode"))
            AND (${only}::uuid[] IS NULL OR b.id = ANY(${only}::uuid[]))
            AND (${after}::uuid IS NULL OR b.id > ${after}::uuid)
          ORDER BY b.id LIMIT ${limit}
        )
        SELECT m.id::text AS id, m.currency, m.net, m.reserved,
          COALESCE(-(SELECT SUM(e."amountMinor") FROM ledger_entries e WHERE e."bookingId" = m.id AND e.mode = ${mode}::"PaymentMode" AND e.currency = m.currency AND e."accountCode" = ${LEDGER_ACCOUNTS.funds}), 0)::bigint AS funds,
          COALESCE(-(SELECT SUM(e."amountMinor") FROM ledger_entries e WHERE e."bookingId" = m.id AND e.mode = ${mode}::"PaymentMode" AND e.currency = m.currency AND e."accountCode" = ${LEDGER_ACCOUNTS.overpayments}), 0)::bigint AS over,
          COALESCE((SELECT SUM(e."amountMinor") FROM ledger_entries e WHERE e."bookingId" = m.id AND e.mode = ${mode}::"PaymentMode" AND e.currency = m.currency AND e."accountCode" = ${LEDGER_ACCOUNTS.receivable}), 0)::bigint AS receivable
        FROM money m ORDER BY m.id`;
      for (const b of bookings) {
        // The customer money the ledger holds for the booking is what was collected less refunded (plan 0.1, P8).
        if (b.funds + b.over - b.receivable !== b.net) {
          out.push({ kind: 'booking_total', entityType: 'Booking', entityId: b.id });
          continue;
        }
        const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { sequence: true, amountMinor: true } });
        // Task 4.5: the plan is filled with what is allocatable (refunds in flight keep their money in overpayments), and
        // money out beyond money in is the receivable.
        const split = allocate(items, b.net - b.reserved);
        if (split.items.reduce((s, i) => s + i.paidMinor, 0n) !== b.funds || split.overpaidMinor + b.reserved !== b.over || -split.receivableMinor !== b.receivable) out.push({ kind: 'booking_split', entityType: 'Booking', entityId: b.id });
      }

      if (!only) {
        const clearing = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT a.id::text AS id FROM provider_accounts a
          WHERE a.mode = ${mode}::"PaymentMode" AND
            COALESCE((SELECT SUM(e."amountMinor") FROM ledger_entries e WHERE e."accountCode" = 'provider_clearing:' || a.id::text AND e.mode = a.mode), 0)
            <> COALESCE((SELECT SUM(p."amountMinor") FROM payments p WHERE p."providerAccountId" = a.id AND p.status = 'succeeded'), 0)
             - COALESCE((SELECT SUM(r."amountMinor") FROM refunds r WHERE r."providerAccountId" = a.id AND r.status = 'succeeded'), 0)
             - COALESCE((SELECT SUM(d."amountMinor") FROM disputes d WHERE d."providerAccountId" = a.id AND d."fundsWithdrawnAt" IS NOT NULL AND d."fundsReinstatedAt" IS NULL), 0)
          ORDER BY a.id`;
        for (const r of clearing) out.push({ kind: 'clearing', entityType: 'ProviderAccount', entityId: r.id });
        const empty = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT t.id::text AS id FROM ledger_transactions t WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e."transactionId" = t.id) ORDER BY t.id LIMIT 100`;
        for (const r of empty) out.push({ kind: 'empty_transaction', entityType: 'LedgerTransaction', entityId: r.id });
      }
      return { findings: out, next: bookings.length === limit ? bookings[bookings.length - 1]!.id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 10_000 });
  }
}
