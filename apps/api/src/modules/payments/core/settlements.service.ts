// Gateway settlements (payouts) and their fees (plan docs/plans/4.6-reconciliation-receipts.md, sections 2.2, 3.1, 3.4
// and review R3, R4). A settlement is stored once as the gateway reported it; its lines are matched to our payments,
// refunds and disputes (once, possibly on a later run) and each matched line's fee is posted once, `fee:<lineId>`.
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { readBookingForPayments } from '../../bookings';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { LedgerService } from './ledger.service';
import { settlementFeeKey } from './ledger';
import { PAYMENT_TX_OPTIONS } from './payable-states';
import type { PaymentProvider, ProviderContext, ProviderSettlement } from './provider';
import type { Difference } from './reconciliation-types';
import { moneySide } from './reconciliation-types';

type Mode = 'test' | 'live';
/** A call to the account's gateway with the reconciliation's error counting (operation `retrieve`). */
export type GatewayCaller = <T>(fn: (provider: PaymentProvider, ctx: ProviderContext) => Promise<T>) => Promise<T>;

/** Canonical content of a settlement: a later listing with the same reference and other content is a difference. */
export function settlementSha256(s: ProviderSettlement): string {
  const lines = [...s.lines].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map((l) => [l.ref, l.kind, l.paymentRef ?? null, l.refundRef ?? null, l.disputeRef ?? null, l.amountMinor.toString(), l.feeMinor.toString()]);
  return createHash('sha256').update(JSON.stringify([s.ref, s.payoutDate, s.currency, s.grossMinor.toString(), s.feesMinor.toString(), s.netMinor.toString(), lines])).digest('hex');
}

/** The settlement's own arithmetic: net = gross − fees, lines add up to gross, line fees to fees. */
export function settlementConsistent(s: ProviderSettlement): boolean {
  return s.netMinor === s.grossMinor - s.feesMinor
    && s.lines.reduce((t, l) => t + l.amountMinor, 0n) === s.grossMinor
    && s.lines.reduce((t, l) => t + l.feeMinor, 0n) === s.feesMinor;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REF = /^[A-Za-z0-9_.:-]{1,255}$/;
const okRef = (r: string | undefined): boolean => r === undefined || REF.test(r);

@Injectable()
export class SettlementsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /** Lists the account's payouts since `payoutDateFrom`, page by page, and stores the new ones. */
  async importAccount(accountId: string, mode: Mode, payoutDateFrom: string, call: GatewayCaller): Promise<{ differences: Difference[]; listed: number }> {
    const differences: Difference[] = [];
    let listed = 0;
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 200; pageNo++) {
      const page = await call((p, ctx) => p.listSettlements!(ctx, { payoutDateFrom, ...(cursor ? { cursor } : {}) }));
      for (const s of page.items) {
        listed += 1;
        differences.push(...(await this.store(accountId, mode, s)));
      }
      if (!page.next) break;
      cursor = page.next;
    }
    return { differences, listed };
  }

  private async store(accountId: string, mode: Mode, s: ProviderSettlement): Promise<Difference[]> {
    const shape = REF.test(s.ref) && DATE.test(s.payoutDate) && /^[A-Z]{3}$/.test(s.currency) && s.lines.length <= 10_000
      && s.lines.every((l) => REF.test(l.ref) && okRef(l.paymentRef) && okRef(l.refundRef) && okRef(l.disputeRef) && !(l.refundRef && l.disputeRef))
      && new Set(s.lines.map((l) => l.ref)).size === s.lines.length;
    const ref = REF.test(s.ref) ? s.ref : 'invalid';
    if (!shape || !settlementConsistent(s)) {
      return [{ code: 'settlement_totals_inconsistent', entityType: 'GatewayObject', entityId: ref, gateway: moneySide(s.netMinor, /^[A-Z]{3}$/.test(s.currency) ? s.currency : undefined) }];
    }
    const sha = settlementSha256(s);
    const known = await this.prisma.settlement.findUnique({ where: { providerAccountId_providerSettlementRef: { providerAccountId: accountId, providerSettlementRef: s.ref } }, select: { id: true, contentSha256: true } });
    if (known) return known.contentSha256 === sha ? [] : [{ code: 'settlement_changed', entityType: 'Settlement', entityId: known.id }];
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.settlement.create({
        data: { providerAccountId: accountId, mode, providerSettlementRef: s.ref, payoutDate: new Date(`${s.payoutDate}T00:00:00Z`), currency: s.currency, grossMinor: s.grossMinor, feesMinor: s.feesMinor, netMinor: s.netMinor, contentSha256: sha },
        select: { id: true },
      });
      await tx.settlementLine.createMany({
        data: s.lines.map((l) => ({
          settlementId: row.id, mode, currency: s.currency, providerLineRef: l.ref, kind: l.kind, amountMinor: l.amountMinor, feeMinor: l.feeMinor,
          paymentRef: l.paymentRef ?? null, refundRef: l.refundRef ?? null, disputeRef: l.disputeRef ?? null,
        })),
      });
    }).catch(async (err: unknown) => {
      // Another run stored it meanwhile: the next listing compares it.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    });
    return [];
  }

  /**
   * Matches every line of the account that has no match yet (review R4: also lines whose payment we only learnt of
   * later). A line matches one object of this account, in its currency, with the amount the line should carry. Returns
   * the differences of the lines that still do not match.
   */
  async matchPending(accountId: string, mode: Mode): Promise<Difference[]> {
    const lines = await this.prisma.$queryRaw<Array<{ id: string; kind: string; currency: string; amountMinor: bigint; paymentRef: string | null; refundRef: string | null; disputeRef: string | null }>>`
      SELECT l.id::text AS id, l.kind::text AS kind, l.currency, l."amountMinor", l."paymentRef", l."refundRef", l."disputeRef"
      FROM settlement_lines l JOIN settlements s ON s.id = l."settlementId"
      WHERE s."providerAccountId" = ${accountId}::uuid AND l.mode = ${mode}::"PaymentMode"
        AND NOT EXISTS (SELECT 1 FROM settlement_line_matches m WHERE m."lineId" = l.id)
      ORDER BY l.id LIMIT 5000`;
    const out: Difference[] = [];
    for (const l of lines) {
      const target = await this.findTarget(accountId, mode, l);
      if (!target) {
        out.push({ code: 'settlement_line_unmatched', entityType: 'SettlementLine', entityId: l.id, gateway: moneySide(l.amountMinor, l.currency, l.kind) });
        continue;
      }
      if (target.currency !== l.currency) {
        out.push({ code: 'settlement_currency_differs', entityType: 'SettlementLine', entityId: l.id, ours: moneySide(target.expectedMinor, target.currency), gateway: moneySide(l.amountMinor, l.currency) });
        continue;
      }
      if (target.expectedMinor !== l.amountMinor) {
        out.push({ code: 'settlement_line_amount_differs', entityType: 'SettlementLine', entityId: l.id, ours: moneySide(target.expectedMinor, target.currency), gateway: moneySide(l.amountMinor, l.currency) });
        continue;
      }
      // Code review M1: an object paid out by an earlier line (another payout, another reference) is a duplicate: no match,
      // no second fee. The partial unique indexes of 0037 hold the same rule against a concurrent run.
      const inserted = await this.prisma.$executeRaw`
        INSERT INTO settlement_line_matches (id, "lineId", mode, kind, "paymentId", "refundId", "disputeId", "bookingId")
        VALUES (gen_random_uuid(), ${l.id}::uuid, ${mode}::"PaymentMode", ${l.kind}::"SettlementLineKind", ${target.paymentId}::uuid, ${target.refundId}::uuid, ${target.disputeId}::uuid, ${target.bookingId}::uuid)
        ON CONFLICT DO NOTHING`;
      if (inserted === 0) {
        const mine = await this.prisma.settlementLineMatch.count({ where: { lineId: l.id } });
        if (mine === 0) out.push({ code: 'settlement_line_duplicate', entityType: 'SettlementLine', entityId: l.id, gateway: moneySide(l.amountMinor, l.currency, l.kind) });
      }
    }
    return out;
  }

  private async findTarget(accountId: string, mode: Mode, l: { kind: string; paymentRef: string | null; refundRef: string | null; disputeRef: string | null }) {
    const none = { paymentId: null as string | null, refundId: null as string | null, disputeId: null as string | null };
    if (l.kind === 'charge' && l.paymentRef) {
      const p = await this.prisma.payment.findFirst({ where: { providerAccountId: accountId, mode, providerPaymentRef: l.paymentRef, status: 'succeeded' }, select: { id: true, bookingId: true, amountMinor: true, currency: true } });
      return p ? { ...none, paymentId: p.id, bookingId: p.bookingId, currency: p.currency, expectedMinor: p.amountMinor } : null;
    }
    if (l.kind === 'refund' && l.refundRef) {
      const r = await this.prisma.refund.findFirst({ where: { providerAccountId: accountId, mode, providerRefundRef: l.refundRef, status: 'succeeded' }, select: { id: true, bookingId: true, amountMinor: true, currency: true } });
      return r ? { ...none, refundId: r.id, bookingId: r.bookingId, currency: r.currency, expectedMinor: -r.amountMinor } : null;
    }
    if ((l.kind === 'dispute_withdrawal' || l.kind === 'dispute_reinstatement') && l.disputeRef) {
      const withdrawal = l.kind === 'dispute_withdrawal';
      const d = await this.prisma.dispute.findFirst({
        where: { providerAccountId: accountId, mode, providerDisputeRef: l.disputeRef, ...(withdrawal ? { fundsWithdrawnAt: { not: null } } : { fundsReinstatedAt: { not: null } }) },
        select: { id: true, bookingId: true, amountMinor: true, currency: true },
      });
      return d ? { ...none, disputeId: d.id, bookingId: d.bookingId, currency: d.currency, expectedMinor: withdrawal ? -d.amountMinor : d.amountMinor } : null;
    }
    // Adjustments and anything else never match: a person looks at them.
    return null;
  }

  /**
   * Posts the fee of every matched line of the account that has none yet (review R4: a crash between storing and
   * posting, or a line matched late). One transaction per line, with its booking locked. Returns how many it posted.
   */
  async postMissingFees(accountId: string, mode: Mode): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ lineId: string; feeMinor: bigint; bookingId: string; paymentId: string | null; refundId: string | null; disputeId: string | null }>>`
      SELECT l.id::text AS "lineId", l."feeMinor", m."bookingId"::text AS "bookingId", m."paymentId"::text AS "paymentId", m."refundId"::text AS "refundId", m."disputeId"::text AS "disputeId"
      FROM settlement_lines l JOIN settlements s ON s.id = l."settlementId" JOIN settlement_line_matches m ON m."lineId" = l.id
      WHERE s."providerAccountId" = ${accountId}::uuid AND l.mode = ${mode}::"PaymentMode" AND l."feeMinor" <> 0
        AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t."idempotencyKey" = 'fee:' || l.id::text)
      ORDER BY l.id LIMIT 5000`;
    let posted = 0;
    for (const f of due) {
      const done = await runTransaction(this.prisma, async (tx) => {
        const b = await readBookingForPayments(tx, { id: f.bookingId }, true);
        if (!b) return false;
        // Under the lock: posted meanwhile by another run?
        const [exists] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM ledger_transactions WHERE "idempotencyKey" = ${settlementFeeKey(f.lineId)}`;
        if (exists && exists.n > 0n) return false;
        await this.ledger.postSettlementFee(tx, { id: b.id, currency: b.currency }, {
          lineId: f.lineId, providerAccountId: accountId, feeMinor: f.feeMinor, mode,
          ...(f.paymentId ? { paymentId: f.paymentId } : {}), ...(f.refundId ? { refundId: f.refundId } : {}), ...(f.disputeId ? { disputeId: f.disputeId } : {}),
        });
        return true;
      }, PAYMENT_TX_OPTIONS);
      if (done) posted += 1;
    }
    return posted;
  }
}
