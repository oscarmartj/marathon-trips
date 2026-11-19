// The daily reconciliation, settlements and their fees, and the dispute sweep, against the simulator (plan
// docs/plans/4.6-reconciliation-receipts.md, sections 2, 3 and 12). Each test gets its own gateway account, and runs
// "two hours from now" so nothing it just did counts as in flight.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DisputeSyncService } from '../../../src/modules/payments/core/dispute-sync.service';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { LedgerService } from '../../../src/modules/payments/core/ledger.service';
import { ReceiptsService } from '../../../src/modules/payments/core/receipts.service';
import { ReconciliationService, reconciliationTaskRef } from '../../../src/modules/payments/core/reconciliation.service';
import { coverageLostTaskRef } from '../../../src/modules/payments/core/refunds.service';
import { SettlementsService } from '../../../src/modules/payments/core/settlements.service';
import { SIMULATOR_DISPUTE_FEE, simulatorChargeFee } from '../../../src/modules/payments/adapters/simulator/simulator';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { ProviderAccountsService } from '../../../src/modules/payments/core/accounts.service';
import { todayInBrisbane } from '../../../src/modules/bookings';
import { TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { CATALOGUE_AND_PRICING, Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { connect, txError } from '../../support/ledger';
import { pricedWorld } from '../../support/pricing';
import {
  ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount,
} from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  c = await payingCustomer(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const later = () => new Date(Date.now() + 2 * 3_600_000);
const recon = () => t.app.get(ReconciliationService);
const today = () => new Date().toISOString().slice(0, 10);
const codes = (run: { differences: Array<{ code: string }> }) => run.differences.map((d) => d.code).sort();

async function fresh(): Promise<SimAccount> {
  const a = await simulatorAccount(t);
  await onlyAccount(t, a.id);
  return a;
}

async function paid(a: SimAccount): Promise<{ reference: string; bookingId: string; payment: { id: string; bookingId: string; providerPaymentRef: string | null; amountMinor: bigint } }> {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  sim.settle(a.id, p.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, a, await eventFor(t, a, p.id))).outcome).toBe('processed');
  // Receipts are issued by the outbox consumer, which does not run in tests: the sweep stands in for it.
  await t.app.get(ReceiptsService).sweep({ bookingIds: [bookingId] });
  return { reference, bookingId, payment: await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } }) };
}

const run = async (a: SimAccount) => (await recon().runAccount(a.id, { now: later() }))!;
const feePostings = (lineIds: string[]) => t.prisma.ledgerTransaction.findMany({ where: { idempotencyKey: { in: lineIds.map((id) => `fee:${id}`) } } });
/** The ledger check's findings about this gateway account: its clearing, its settlement lines and its fee postings. */
async function clearingFindings(a: SimAccount) {
  const all = (await t.app.get(PaymentLedgerCheckService).checkPage({ limit: 1 })).findings;
  const lines = new Set((await t.prisma.settlementLine.findMany({ where: { settlement: { providerAccountId: a.id } }, select: { id: true } })).map((l) => l.id));
  const txs = new Set((await t.prisma.ledgerEntry.findMany({ where: { accountCode: `provider_clearing:${a.id}` }, select: { transactionId: true } })).map((e) => e.transactionId));
  return all.filter((f) => f.entityId === a.id || (f.kind === 'missing_fee_posting' && lines.has(f.entityId)) || (f.kind === 'fee_without_line' && txs.has(f.entityId)));
}

describe('reconciliation against the simulator (plan 4.6, 2.3)', () => {
  it('clean_world_reconciles_matched: payments, a payout and its fees, nothing to report', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    sim.payout(a.id, today());
    const r = await run(a);
    expect([r.status, r.differences]).toEqual(['matched', []]);
    expect(r.checkedObjects).toBeGreaterThan(0);
    const lines = await t.prisma.settlementLine.findMany({ where: { settlement: { providerAccountId: a.id } }, include: { matches: true } });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.matches[0]!.paymentId).toBe(payment.id);
    const fees = await feePostings(lines.map((l) => l.id));
    expect(fees).toHaveLength(1);
    expect(fees[0]!.kind).toBe('fee');
    expect(await clearingFindings(a)).toEqual([]);
    expect(await t.prisma.task.count({ where: { sourceRef: { startsWith: 'payments:recon' }, entityId: a.id, status: 'open' } })).toBe(0);
  });

  it('reconciliation_detects_injected_difference: each injected difference gives its code and a task, and nothing is changed', async () => {
    const cases: Array<{ name: string; inject: (a: SimAccount, p: { id: string; providerPaymentRef: string | null; amountMinor: bigint }) => void; code: string }> = [
      { name: 'amount', inject: (a, p) => sim.alterPayment(a.id, p.providerPaymentRef!, { amountMinor: p.amountMinor + 1n }), code: 'payment_amount_differs' },
      { name: 'status', inject: (a, p) => sim.alterPayment(a.id, p.providerPaymentRef!, { status: 'failed' }), code: 'payment_status_differs' },
      { name: 'lost', inject: (a, p) => sim.dropPayment(a.id, p.providerPaymentRef!), code: 'payment_missing_at_gateway' },
      { name: 'unknown payment', inject: (a) => void sim.foreignPayment(a.id, 4200n), code: 'unknown_gateway_payment' },
      { name: 'external refund', inject: (a, p) => void sim.gatewayRefund(a.id, p.providerPaymentRef!, 500n), code: 'unknown_gateway_refund' },
    ];
    for (const k of cases) {
      const a = await fresh();
      const { bookingId, payment } = await paid(a);
      const ledgerBefore = await t.prisma.ledgerTransaction.count({ where: { bookingId } });
      k.inject(a, payment);
      const r = await run(a);
      expect(r.status, k.name).toBe('mismatch');
      expect(codes(r), k.name).toContain(k.code);
      const d = r.differences.find((x) => x.code === k.code)!;
      expect(await t.prisma.task.count({ where: { sourceRef: reconciliationTaskRef(d.code, d.entityId), status: 'open' } }), k.name).toBe(1);
      expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } }), `${k.name}: the ledger is not touched`).toBe(ledgerBefore);
      expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.reconciliation.mismatch', aggregateId: r.id } }), k.name).toBe(1);
      // Review R9: a refund at the gateway we have no record of stops the booking collecting.
      if (k.code === 'unknown_gateway_refund') expect(await t.prisma.task.count({ where: { sourceRef: coverageLostTaskRef(bookingId), status: 'open' } })).toBe(1);
    }
  });

  it('settlement_changed, settlement_line_unmatched and settlement_currency_differs (review R3); nothing posted for them', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    const po = sim.payout(a.id, today());
    expect((await run(a)).status).toBe('matched');
    sim.alterPayout(a.id, po.ref, (s) => {
      s.lines[0]!.feeMinor += 1n;
      s.feesMinor += 1n;
      s.netMinor -= 1n;
    });
    sim.addPayout(a.id, { ref: `po_nzd_${randomUUID()}`, payoutDate: today(), currency: 'NZD', grossMinor: payment.amountMinor, feesMinor: 0n, netMinor: payment.amountMinor, lines: [{ ref: 'l_nzd', kind: 'charge', paymentRef: payment.providerPaymentRef!, amountMinor: payment.amountMinor, feeMinor: 0n }] });
    sim.addPayout(a.id, { ref: `po_adj_${randomUUID()}`, payoutDate: today(), currency: 'AUD', grossMinor: -100n, feesMinor: 0n, netMinor: -100n, lines: [{ ref: 'l_adj', kind: 'adjustment', amountMinor: -100n, feeMinor: 0n }] });
    sim.addPayout(a.id, { ref: `po_bad_${randomUUID()}`, payoutDate: today(), currency: 'AUD', grossMinor: 100n, feesMinor: 0n, netMinor: 99n, lines: [] });
    const r = await run(a);
    expect(codes(r)).toEqual(['settlement_changed', 'settlement_currency_differs', 'settlement_line_unmatched', 'settlement_totals_inconsistent']);
    const nzdLine = await t.prisma.settlementLine.findFirstOrThrow({ where: { providerLineRef: 'l_nzd', settlement: { providerAccountId: a.id } }, include: { matches: true } });
    expect(nzdLine.matches).toEqual([]);
    // The stored settlement keeps what was first imported.
    expect((await t.prisma.settlement.findUniqueOrThrow({ where: { providerAccountId_providerSettlementRef: { providerAccountId: a.id, providerSettlementRef: po.ref } } })).feesMinor).toBe(po.feesMinor);
  });

  it('settlement_fee_posted_once_per_line and negative_settlement_reconciles: a chargeback paid out with its fee', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    sim.payout(a.id, today());
    expect((await run(a)).status).toBe('matched');
    const d = sim.openDispute(a.id, payment.providerPaymentRef!, { withdrawn: true });
    expect((await deliver(t, a, sim.disputeEvent(a.secret, a.id, d.ref))).outcome).toBe('processed');
    await t.app.get(ReceiptsService).sweep({ bookingIds: [(await t.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).bookingId] });
    const second = sim.payout(a.id, today());
    expect(second.netMinor).toBe(-payment.amountMinor - SIMULATOR_DISPUTE_FEE);
    const r1 = await run(a);
    const r2 = await run(a);
    expect([r1.status, r2.status, r2.attempt]).toEqual(['matched', 'matched', r1.attempt + 1]);
    const lines = await t.prisma.settlementLine.findMany({ where: { settlement: { providerAccountId: a.id } } });
    const fees = await feePostings(lines.map((l) => l.id));
    expect(fees).toHaveLength(2);
    const entries = await t.prisma.ledgerEntry.findMany({ where: { transactionId: { in: fees.map((f) => f.id) }, accountCode: 'payment_fees' } });
    expect(entries.reduce((s, e) => s + e.amountMinor, 0n)).toBe(simulatorChargeFee(payment.amountMinor) + SIMULATOR_DISPUTE_FEE);
    expect(await clearingFindings(a)).toEqual([]);
  });

  it('fee_posted_after_crash_between_import_and_posting and late_matched_line_posts_fee (review R4)', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    sim.payout(a.id, today());
    const call = <T,>(fn: Parameters<Parameters<SettlementsService['importAccount']>[3]>[0]) => t.app.get(ProviderGateway).call(a.id, 'retrieve', fn) as Promise<T>;
    // Stored and matched, then "the process dies" before posting.
    await t.app.get(SettlementsService).importAccount(a.id, 'test', today(), call as never);
    expect(await t.app.get(SettlementsService).matchPending(a.id, 'test')).toEqual([]);
    expect((await clearingFindings(a)).map((f) => f.kind)).toContain('missing_fee_posting');
    expect((await run(a)).status).toBe('matched');
    expect(await clearingFindings(a)).toEqual([]);

    // A charge the gateway paid out before our webhook arrived: unmatched first, matched and posted on a later run.
    const late = await approvedBooking(t, admin, await pricedWorld(admin), c);
    expect((await c.pay(late.reference, { method: 'card' })).status).toBe(201);
    const p2 = (await t.prisma.payment.findMany({ where: { bookingId: late.bookingId } }))[0]!;
    sim.settle(a.id, p2.providerPaymentRef!, 'succeeded');
    sim.payout(a.id, today());
    const r1 = await recon().runAccount(a.id, { now: new Date() });
    expect(codes(r1!)).toContain('settlement_line_unmatched');
    expect((await deliver(t, a, await eventFor(t, a, p2.id))).outcome).toBe('processed');
    await t.app.get(ReceiptsService).sweep({ bookingIds: [late.bookingId] });
    const r2 = await run(a);
    expect(r2.differences.filter((d) => d.code.startsWith('settlement'))).toEqual([]);
    const line = await t.prisma.settlementLine.findFirstOrThrow({ where: { paymentRef: p2.providerPaymentRef!, settlement: { providerAccountId: a.id } } });
    expect(await feePostings([line.id])).toHaveLength(1);
    expect(payment.id).not.toBe(p2.id);
  });

  it('wrong_fee_posting_flagged: a fee posted with another amount is a finding of the ledger check (review R1)', async () => {
    const a = await fresh();
    const { bookingId, payment } = await paid(a);
    sim.payout(a.id, today());
    const call = (fn: never) => t.app.get(ProviderGateway).call(a.id, 'retrieve', fn);
    await t.app.get(SettlementsService).importAccount(a.id, 'test', today(), call as never);
    await t.app.get(SettlementsService).matchPending(a.id, 'test');
    const line = await t.prisma.settlementLine.findFirstOrThrow({ where: { settlement: { providerAccountId: a.id } } });
    await t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      await t.app.get(LedgerService).postSettlementFee(tx, { id: b.id, currency: b.currency }, { lineId: line.id, providerAccountId: a.id, feeMinor: line.feeMinor + 7n, mode: 'test', paymentId: payment.id });
    });
    const kinds = (await clearingFindings(a)).map((f) => f.kind);
    expect(kinds).toContain('fee_without_line');
    expect(kinds).toContain('clearing');
  });

  it('lost_dispute_webhook_closed_by_sweep and dispute_unknown_at_gateway_reported', async () => {
    const a = await fresh();
    const { bookingId, payment } = await paid(a);
    const d = sim.openDispute(a.id, payment.providerPaymentRef!);
    expect((await deliver(t, a, sim.disputeEvent(a.secret, a.id, d.ref))).outcome).toBe('processed');
    // The gateway decides; the webhook is lost.
    sim.moveDispute(a.id, d.ref, { status: 'won' });
    const r = await run(a);
    expect(r.status).toBe('matched');
    const row = await t.prisma.dispute.findFirstOrThrow({ where: { bookingId } });
    expect(row.status).toBe('won');
    expect(await t.prisma.task.count({ where: { sourceRef: { startsWith: 'payments:dispute_review:' }, entityId: row.id } })).toBe(0);

    const b = await paid(a);
    const d2 = sim.openDispute(a.id, b.payment.providerPaymentRef!);
    expect((await deliver(t, a, sim.disputeEvent(a.secret, a.id, d2.ref))).outcome).toBe('processed');
    sim.forget(a.id);
    const gone = await run(a);
    expect(gone.differences.map((x) => x.code)).toContain('dispute_unknown_at_gateway');
  });

  it('dispute_of_ours_unknown_locally_is_registered (review R9)', async () => {
    const a = await fresh();
    const { bookingId, payment } = await paid(a);
    sim.openDispute(a.id, payment.providerPaymentRef!);
    const r = await run(a);
    expect(r.differences.filter((d) => d.code === 'unknown_gateway_dispute')).toEqual([]);
    expect(await t.prisma.dispute.count({ where: { bookingId } })).toBe(1);
  });

  it('sweep_stale_read_after_webhook_no_review: a dispute changed since it was read is left alone (review R5)', async () => {
    const a = await fresh();
    const { bookingId, payment } = await paid(a);
    const d = sim.openDispute(a.id, payment.providerPaymentRef!);
    expect((await deliver(t, a, sim.disputeEvent(a.secret, a.id, d.ref))).outcome).toBe('processed');
    const seen = await t.prisma.dispute.findFirstOrThrow({ where: { bookingId } });
    // The sweep read `open`; meanwhile the webhook says `won`.
    const openNow = await t.app.get(ProviderGateway).call(a.id, 'retrieve', async (p, ctx) => p.retrieveDispute!(ctx, d.ref));
    sim.moveDispute(a.id, d.ref, { status: 'won' });
    expect((await deliver(t, a, sim.disputeEvent(a.secret, a.id, d.ref))).outcome).toBe('processed');
    const out = await t.app.get(DisputeSyncService).apply(a.id, openNow!, `sweep:${seen.id}:test`, { id: seen.id, version: seen.version });
    expect(out).toBe('skipped');
    expect((await t.prisma.dispute.findUniqueOrThrow({ where: { id: seen.id } })).status).toBe('won');
    expect(await t.prisma.task.count({ where: { sourceRef: { startsWith: 'payments:dispute_review:' }, entityId: seen.id } })).toBe(0);
  });
});

describe('failures, concurrency and access (plan 4.6, 7 and review R10, R11)', () => {
  it('reconciliation_gateway_down_marks_failed_and_continues: cut off after three errors in a row, with a task', async () => {
    const a = await fresh();
    await paid(a);
    sim.failNextList(a.id, 'unavailable', 'unavailable', 'unavailable', 'unavailable');
    for (let i = 0; i < 4; i++) sim.failNextRetrieve(a.id, 'unavailable');
    const r = await run(a);
    expect([r.status, r.errorCode]).toEqual(['failed', 'provider_unavailable']);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:reconciliation_failed:${a.id}`, status: 'open' } })).toBe(1);
    // Listing is a `retrieve`: it never feeds gateway health (only creates do, task 4.2).
    expect(await t.prisma.providerAccountHealth.findUnique({ where: { providerAccountId: a.id } }).then((h) => h?.consecutiveFailures ?? 0)).toBe(0);
    const again = await run(a);
    expect(again.attempt).toBe(r.attempt + 1);
  });

  it('an open breaker does not stop the reconciliation (it only guards new payments)', async () => {
    const a = await fresh();
    await paid(a);
    await t.prisma.$executeRawUnsafe(`INSERT INTO provider_account_health ("providerAccountId", "consecutiveFailures", "openedAt", "openUntil", "updatedAt") VALUES ($1::uuid, 9, now(), now() + interval '1 hour', now())
      ON CONFLICT ("providerAccountId") DO UPDATE SET "consecutiveFailures" = 9, "openedAt" = now(), "openUntil" = now() + interval '1 hour'`, a.id);
    expect((await run(a)).status).toBe('matched');
    await t.prisma.$executeRawUnsafe(`UPDATE provider_account_health SET "consecutiveFailures" = 0, "openedAt" = NULL, "openUntil" = NULL WHERE "providerAccountId" = $1::uuid`, a.id);
  });

  it('reconciliation_running: one run per account at a time; runs are closed once and never deleted', async () => {
    const a = await fresh();
    const db = await connect('app');
    try {
      // Code review M4: the run is for the Brisbane date of the time it runs at, not the database's current_date.
      const forDate = todayInBrisbane(later());
      await db.query(`INSERT INTO reconciliation_runs (id, "providerAccountId", mode, "forDate", attempt, trigger) VALUES (gen_random_uuid(), $1::uuid, 'test', $2::date, 99, 'scheduled')`, [a.id, forDate]);
      expect(await recon().runAccount(a.id, { now: later() })).toBeNull();
      const res = await admin.post(`/admin/payments/reconciliation/accounts/${a.id}/run`, {});
      expect([res.status, res.body.code]).toEqual([409, 'reconciliation_running']);
      const done = (await t.prisma.reconciliationRun.findFirstOrThrow({ where: { providerAccountId: a.id, attempt: 99 } })).id;
      expect(await txError(db, [[`DELETE FROM reconciliation_runs WHERE id = $1::uuid`, [done]]])).not.toBeNull();
      await db.query(`UPDATE reconciliation_runs SET status = 'failed', "errorCode" = 'test', "finishedAt" = now() WHERE id = $1::uuid`, [done]);
      expect(await txError(db, [[`UPDATE reconciliation_runs SET status = 'matched' WHERE id = $1::uuid`, [done]]])).not.toBeNull();
      expect(await txError(db, [[`INSERT INTO reconciliation_runs (id, "providerAccountId", mode, "forDate", attempt, trigger, status, "finishedAt") VALUES (gen_random_uuid(), $1::uuid, 'test', $2::date, 100, 'scheduled', 'matched', now())`, [a.id, forDate]]])).not.toBeNull();
    } finally {
      await db.end();
    }
    // The next run of the same day comes after the attempts already taken.
    expect((await run(a)).attempt).toBe(100);
  });

  it('manual_run_requires_step_up_and_permission; it is audited; the panel lists runs', async () => {
    const a = await fresh();
    const reader = await staffClient(t, [...CATALOGUE_AND_PRICING, 'payments.reconciliation.read']);
    expect((await reader.post(`/admin/payments/reconciliation/accounts/${a.id}/run`, {})).status).toBe(403);
    const stale = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
    await t.prisma.session.updateMany({ where: { userId: stale.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const r = await stale.post(`/admin/payments/reconciliation/accounts/${a.id}/run`, {});
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    const ok = await admin.post(`/admin/payments/reconciliation/accounts/${a.id}/run`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.trigger).toBe('manual');
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.reconciliation.run', entityId: a.id } })).toBe(1);
    const list = await reader.get(`/admin/payments/reconciliation/runs?accountId=${a.id}`);
    expect(list.status).toBe(200);
    expect(list.body.runs[0].id).toBe(ok.body.id);
    expect((await reader.get(`/admin/payments/reconciliation/runs/${ok.body.id}`)).body.status).toBe(ok.body.status);
    const none = await staffClient(t, CATALOGUE_AND_PRICING);
    expect((await none.get('/admin/payments/reconciliation/runs')).status).toBe(403);
  });

  it('manual_accounts_not_applicable', async () => {
    const { id } = await t.app.get(ProviderAccountsService).createManualAccount({ displayName: `Bank transfer ${randomUUID().slice(0, 8)}` });
    await t.prisma.providerAccount.update({ where: { id }, data: { status: 'paused' } });
    const r = await recon().runAccount(id, { now: later() });
    expect([r!.status, r!.differences]).toEqual(['not_applicable', []]);
  });
});

/** Two payments of one booking where the first succeeds late, so the first owns an overpayment (as in app-refunds). */
async function overpaid(a: SimAccount) {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const attempt = async () => {
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    return (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  };
  const late = await attempt();
  await deliver(t, a, await eventFor(t, a, late.id, { status: 'failed' }));
  const p = await attempt();
  sim.settle(a.id, p.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, a, await eventFor(t, a, p.id))).outcome).toBe('processed');
  sim.settle(a.id, late.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, a, await eventFor(t, a, late.id))).outcome).toBe('processed');
  await t.app.get(ReceiptsService).sweep({ bookingIds: [bookingId] });
  return { bookingId, late: await t.prisma.payment.findUniqueOrThrow({ where: { id: late.id } }) };
}

describe('code review of 4.6 (M1-M4 and failure paths)', () => {
  it('settlement_line_duplicate: one charge in two payouts is matched and charged a fee once (M1)', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    const po = sim.payout(a.id, today());
    const line = po.lines[0]!;
    sim.addPayout(a.id, { ref: `po_dup_${randomUUID()}`, payoutDate: today(), currency: 'AUD', grossMinor: line.amountMinor, feesMinor: line.feeMinor, netMinor: line.amountMinor - line.feeMinor, lines: [{ ...line, ref: `dup_${randomUUID()}` }] });
    const r = await run(a);
    expect(codes(r)).toEqual(['settlement_line_duplicate']);
    const lines = await t.prisma.settlementLine.findMany({ where: { settlement: { providerAccountId: a.id } }, include: { matches: true } });
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.matches.length === 1).map((l) => l.matches[0]!.paymentId)).toEqual([payment.id]);
    expect(await feePostings(lines.map((l) => l.id))).toHaveLength(1);
    // The database holds the rule too: a second match of the same payment is refused.
    const dup = lines.find((l) => l.matches.length === 0)!;
    const db = await connect('app');
    try {
      expect(await txError(db, [[`INSERT INTO settlement_line_matches (id, "lineId", mode, kind, "paymentId", "bookingId") VALUES (gen_random_uuid(), $1::uuid, 'test', 'charge', $2::uuid, $3::uuid)`, [dup.id, payment.id, payment.bookingId]]])).toBe('23505');
    } finally {
      await db.end();
    }
  });

  it('refund_status_differs from the activity: a refund of ours not done here, done at the gateway (M2)', async () => {
    const a = await fresh();
    const { late } = await overpaid(a);
    sim.queueRefund(a.id, 'unavailable');
    const res = await admin.post(`/admin/payments/payments/${late.id}/refunds`, { paymentVersion: late.version, purpose: 'overpayment_return', reason: 'Paid twice by mistake' }).set('Idempotency-Key', randomUUID());
    expect(res.status).toBeLessThan(300);
    const ours = await t.prisma.refund.findFirstOrThrow({ where: { paymentId: late.id } });
    expect(['succeeded', 'pending']).not.toContain(ours.status);
    sim.gatewayRefund(a.id, late.providerPaymentRef!, ours.amountMinor, 'succeeded', ours.id);
    const r = await run(a);
    const d = r.differences.find((x) => x.code === 'refund_status_differs');
    expect(d?.entityId).toBe(ours.id);
  });

  it('unknown_refund_reviews_booking_once: closing the review does not block the booking again (M3)', async () => {
    const a = await fresh();
    const { bookingId, payment } = await paid(a);
    sim.gatewayRefund(a.id, payment.providerPaymentRef!, 500n);
    await run(a);
    const review = await t.prisma.task.findFirstOrThrow({ where: { sourceRef: coverageLostTaskRef(bookingId), status: 'open' } });
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.booking.under_review', entityId: bookingId } })).toBe(1);
    await t.prisma.task.update({ where: { id: review.id }, data: { status: 'done' } });
    const again = await run(a);
    expect(codes(again)).toContain('unknown_gateway_refund');
    expect(await t.prisma.task.count({ where: { sourceRef: coverageLostTaskRef(bookingId), status: 'open' } })).toBe(0);
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.booking.under_review', entityId: bookingId } })).toBe(1);
  });

  it('in_flight_payment_not_reported: what changed in the last hour is not compared', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    sim.alterPayment(a.id, payment.providerPaymentRef!, { amountMinor: payment.amountMinor + 1n });
    const now = await recon().runAccount(a.id, { now: new Date() });
    expect(codes(now!)).not.toContain('payment_amount_differs');
    expect(codes(await run(a))).toContain('payment_amount_differs');
  });

  it('partial_run_when_over_object_cap', async () => {
    const a = await fresh();
    await paid(a);
    await paid(a);
    const r = (await recon().runAccount(a.id, { now: later(), maxObjects: 1 }))!;
    expect([r.status, r.errorCode]).toEqual(['partial', 'object_cap']);
  });

  it('settlement_line_from_other_account_not_matched (finding 2)', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    const b = await fresh();
    sim.addPayout(b.id, { ref: `po_x_${randomUUID()}`, payoutDate: today(), currency: 'AUD', grossMinor: payment.amountMinor, feesMinor: 0n, netMinor: payment.amountMinor, lines: [{ ref: 'l_x', kind: 'charge', paymentRef: payment.providerPaymentRef!, amountMinor: payment.amountMinor, feeMinor: 0n }] });
    const r = await run(b);
    expect(codes(r)).toEqual(['settlement_line_unmatched']);
    expect(await t.prisma.settlementLineMatch.count({ where: { paymentId: payment.id } })).toBe(0);
  });

  it('reconciliation_never_calls_live_outside_production: an account of the other mode is not reconciled', async () => {
    const a = await fresh();
    const gw = t.app.get(ProviderGateway);
    const spy = vi.spyOn(gw, 'mode', 'get').mockReturnValue('live');
    const calls = sim.listCalls(a.id);
    try {
      await expect(recon().runAccount(a.id, { now: later() })).rejects.toMatchObject({ code: 'provider_account_not_found' });
    } finally {
      spy.mockRestore();
    }
    expect(sim.listCalls(a.id)).toBe(calls);
    expect(await t.prisma.reconciliationRun.count({ where: { providerAccountId: a.id } })).toBe(0);
  });

  it('reconciliation_task_deduplicated_while_open; receipt_missing', async () => {
    const a = await fresh();
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const p = (await t.prisma.payment.findMany({ where: { bookingId } }))[0]!;
    sim.settle(a.id, p.providerPaymentRef!, 'succeeded');
    await deliver(t, a, await eventFor(t, a, p.id));
    const r1 = await run(a);
    const r2 = await run(a);
    expect(codes(r1)).toEqual(['receipt_missing']);
    expect(codes(r2)).toEqual(['receipt_missing']);
    expect(await t.prisma.task.count({ where: { sourceRef: reconciliationTaskRef('receipt_missing', p.id), status: 'open' } })).toBe(1);
  });

  it('not_settled_in_time: a payment no payout includes after the grace days', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    const r = (await recon().runAccount(a.id, { now: new Date(Date.now() + 11 * 86_400_000) }))!;
    expect(r.differences.filter((d) => d.code === 'not_settled_in_time').map((d) => d.entityId)).toEqual([payment.id]);
  });

  it('reconciliation_overdue_task and 429 after the manual runs of an hour', async () => {
    const a = await fresh();
    await t.app.get(ReconciliationService).overdue(new Date(Date.now() + 3 * 86_400_000), [{ id: a.id, createdAt: new Date(Date.now() - 3 * 86_400_000) }]);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:reconciliation_overdue:${a.id}`, status: 'open' } })).toBe(1);
    const owner = await paymentsStaff(t);
    for (let i = 0; i < 5; i++) expect((await owner.post(`/admin/payments/reconciliation/accounts/${a.id}/run`, {})).status).toBe(200);
    expect((await owner.post(`/admin/payments/reconciliation/accounts/${a.id}/run`, {})).status).toBe(429);
  });

  it('dispute sweep: lost with funds, closed, a retired account, and an adapter without disputes', async () => {
    const a = await fresh();
    const lost = await paid(a);
    const closed = await paid(a);
    const d1 = sim.openDispute(a.id, lost.payment.providerPaymentRef!);
    const d2 = sim.openDispute(a.id, closed.payment.providerPaymentRef!);
    for (const d of [d1, d2]) expect((await deliver(t, a, sim.disputeEvent(a.secret, a.id, d.ref))).outcome).toBe('processed');
    sim.moveDispute(a.id, d1.ref, { status: 'lost', fundsWithdrawn: true });
    sim.moveDispute(a.id, d2.ref, { status: 'closed' });
    // Retired: no new payments, but disputes, refunds and reconciliation go on (plan 0.1, 6.4).
    await t.prisma.providerAccount.update({ where: { id: a.id }, data: { status: 'retired' } });
    await run(a);
    const l = await t.prisma.dispute.findFirstOrThrow({ where: { bookingId: lost.bookingId } });
    expect([l.status, l.fundsWithdrawnAt !== null]).toEqual(['lost', true]);
    expect(await t.prisma.ledgerTransaction.count({ where: { idempotencyKey: `chargeback:${l.id}:withdrawn` } })).toBe(1);
    expect((await t.prisma.dispute.findFirstOrThrow({ where: { bookingId: closed.bookingId } })).status).toBe('closed');

    // An adapter that does not declare disputes is not swept.
    const b = await fresh();
    const x = await paid(b);
    const d3 = sim.openDispute(b.id, x.payment.providerPaymentRef!);
    expect((await deliver(t, b, sim.disputeEvent(b.secret, b.id, d3.ref))).outcome).toBe('processed');
    sim.moveDispute(b.id, d3.ref, { status: 'won' });
    const gw = t.app.get(ProviderGateway);
    const real = gw.registry.get('simulator')!;
    const noDisputes = Object.create(real) as typeof real;
    Object.defineProperty(noDisputes, 'manifest', { value: { ...real.manifest, capabilities: { ...real.manifest.capabilities, disputes: undefined } } });
    const spy = vi.spyOn(gw.registry, 'get').mockImplementation((key: string) => (key === 'simulator' ? noDisputes : real));
    try {
      await run(b);
    } finally {
      spy.mockRestore();
    }
    expect((await t.prisma.dispute.findFirstOrThrow({ where: { bookingId: x.bookingId } })).status).toBe('open');
  });

  it('a dispute lookup the gateway refuses is skipped, not the whole run (minor 5)', async () => {
    const a = await fresh();
    const { payment } = await paid(a);
    const d = sim.openDispute(a.id, payment.providerPaymentRef!);
    expect((await deliver(t, a, sim.disputeEvent(a.secret, a.id, d.ref))).outcome).toBe('processed');
    sim.failNextDisputeRetrieve(a.id);
    // Round 2 review: the dispute was not checked, so the run is partial, not matched.
    expect([(await run(a)).status, (await t.prisma.reconciliationRun.findFirstOrThrow({ where: { providerAccountId: a.id }, orderBy: { attempt: 'desc' } })).errorCode]).toEqual(['partial', 'gateway_errors']);
  });

  it('an activity item whose reference cannot be stored is reported under a stand-in id (minor 6)', async () => {
    const a = await fresh();
    await paid(a);
    sim.foreignPayment(a.id, 1234n, 'bad ref with spaces & symbols');
    const r = await run(a);
    const d = r.differences.find((x) => x.code === 'unknown_gateway_payment');
    expect(d?.entityId).toMatch(/^invalid_ref:[0-9a-f]{32}$/);
  });

  it('invalid_differences closes the run as failed, never left running (minor 7)', async () => {
    const a = await fresh();
    const { differencesSchema } = await import('../../../src/modules/payments/core/reconciliation-types');
    const spy = vi.spyOn(differencesSchema, 'safeParse').mockReturnValueOnce({ success: false, error: new Error('bad') } as never);
    try {
      const r = await run(a);
      expect([r.status, r.errorCode, r.differences]).toEqual(['failed', 'invalid_differences', []]);
    } finally {
      spy.mockRestore();
    }
    expect(await t.prisma.reconciliationRun.count({ where: { providerAccountId: a.id, status: 'running' } })).toBe(0);
    expect((await run(a)).status).toBe('matched');
  });

  it('an archived account is reconciled inside its dispute window, not after it (minor 8)', async () => {
    const a = await fresh();
    await t.prisma.providerAccount.update({ where: { id: a.id }, data: { status: 'retired' } });
    await t.prisma.providerAccount.update({ where: { id: a.id }, data: { status: 'archived' } });
    const ids = async (at: Date) => (await recon().accountsToReconcile(at)).map((x) => x.id);
    expect(await ids(new Date())).toContain(a.id);
    expect(await ids(new Date(Date.now() + 181 * 86_400_000))).not.toContain(a.id);
    const b = await fresh();
    expect(await ids(new Date(Date.now() + 181 * 86_400_000))).toContain(b.id);
  });
});
