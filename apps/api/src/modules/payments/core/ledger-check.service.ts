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

export type LedgerFindingKind = 'missing_payment_posting' | 'missing_refund_posting' | 'booking_total' | 'booking_split' | 'clearing' | 'empty_transaction';

export interface LedgerFinding {
  kind: LedgerFindingKind;
  entityType: 'Payment' | 'Refund' | 'Booking' | 'ProviderAccount' | 'LedgerTransaction';
  entityId: string;
}

/** Bookings examined per run (oldest money first); the rest wait for the next day. */
const MAX_BOOKINGS = 5000;

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
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.paymentsLedger, async () => void (await this.run()));
    // 17:40 UTC is 03:40 in Brisbane (no daylight saving).
    await this.jobs.schedule(QUEUES.paymentsLedger, '40 17 * * *');
  }

  /** Runs the check and opens a task per finding. `bookingIds` narrows it (tests). */
  async run(opts: { bookingIds?: string[] } = {}): Promise<LedgerFinding[]> {
    const findings = await this.check(opts);
    for (const f of findings) {
      await this.prisma.$transaction((tx) => this.tasks.createSystemIn(tx, {
        title: `Payment ledger check: ${f.kind.replace(/_/g, ' ')}`,
        description: `The daily ledger check found a difference (${f.kind}) for ${f.entityType} ${f.entityId}. Nothing was changed; check the payments and the ledger.`,
        entityType: f.entityType, entityId: f.entityId, sourceRef: `payments:ledger_check:${f.kind}:${f.entityId}`,
      }));
    }
    if (findings.length > 0) this.logger.warn(`ledger check: ${findings.length} finding(s)`);
    return findings;
  }

  /** The findings, read in one consistent snapshot. */
  check(opts: { bookingIds?: string[] } = {}): Promise<LedgerFinding[]> {
    const mode = this.gateway.mode;
    const only = opts.bookingIds ?? null;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
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

      const bookings = await tx.$queryRaw<Array<{ id: string; currency: string; net: bigint; funds: bigint; over: bigint; receivable: bigint }>>`
        WITH money AS (
          SELECT b.id, b.currency,
            COALESCE((SELECT SUM(p."amountMinor") FROM payments p WHERE p."bookingId" = b.id AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded'), 0)::bigint
            - COALESCE((SELECT SUM(r."amountMinor") FROM refunds r WHERE r."bookingId" = b.id AND r.mode = ${mode}::"PaymentMode" AND r.status = 'succeeded'), 0)::bigint AS net
          FROM bookings b
          WHERE (EXISTS (SELECT 1 FROM payments p WHERE p."bookingId" = b.id AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded')
                 OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e."bookingId" = b.id AND e.mode = ${mode}::"PaymentMode"))
            AND (${only}::uuid[] IS NULL OR b.id = ANY(${only}::uuid[]))
          ORDER BY b.id LIMIT ${MAX_BOOKINGS}
        )
        SELECT m.id::text AS id, m.currency, m.net,
          COALESCE(-(SELECT SUM(e."amountMinor") FROM ledger_entries e WHERE e."bookingId" = m.id AND e.mode = ${mode}::"PaymentMode" AND e.currency = m.currency AND e."accountCode" = ${LEDGER_ACCOUNTS.funds}), 0)::bigint AS funds,
          COALESCE(-(SELECT SUM(e."amountMinor") FROM ledger_entries e WHERE e."bookingId" = m.id AND e.mode = ${mode}::"PaymentMode" AND e.currency = m.currency AND e."accountCode" = ${LEDGER_ACCOUNTS.overpayments}), 0)::bigint AS over,
          COALESCE((SELECT SUM(e."amountMinor") FROM ledger_entries e WHERE e."bookingId" = m.id AND e.mode = ${mode}::"PaymentMode" AND e.currency = m.currency AND e."accountCode" = ${LEDGER_ACCOUNTS.receivable}), 0)::bigint AS receivable
        FROM money m`;
      for (const b of bookings) {
        // The customer money the ledger holds for the booking is what was collected less refunded (plan 0.1, P8).
        if (b.funds + b.over - b.receivable !== b.net) {
          out.push({ kind: 'booking_total', entityType: 'Booking', entityId: b.id });
          continue;
        }
        const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { sequence: true, amountMinor: true } });
        const split = b.net >= 0n ? allocate(items, b.net) : null;
        if (!split || split.items.reduce((s, i) => s + i.paidMinor, 0n) !== b.funds || split.overpaidMinor !== b.over) out.push({ kind: 'booking_split', entityType: 'Booking', entityId: b.id });
      }

      if (!only) {
        const clearing = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT a.id::text AS id FROM provider_accounts a
          WHERE a.mode = ${mode}::"PaymentMode" AND
            COALESCE((SELECT SUM(e."amountMinor") FROM ledger_entries e WHERE e."accountCode" = 'provider_clearing:' || a.id::text AND e.mode = a.mode), 0)
            <> COALESCE((SELECT SUM(p."amountMinor") FROM payments p WHERE p."providerAccountId" = a.id AND p.status = 'succeeded'), 0)
             - COALESCE((SELECT SUM(r."amountMinor") FROM refunds r WHERE r."providerAccountId" = a.id AND r.status = 'succeeded'), 0)
          ORDER BY a.id`;
        for (const r of clearing) out.push({ kind: 'clearing', entityType: 'ProviderAccount', entityId: r.id });
        const empty = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT t.id::text AS id FROM ledger_transactions t WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e."transactionId" = t.id) ORDER BY t.id LIMIT 100`;
        for (const r of empty) out.push({ kind: 'empty_transaction', entityType: 'LedgerTransaction', entityId: r.id });
      }
      return out;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 10_000 });
  }
}
