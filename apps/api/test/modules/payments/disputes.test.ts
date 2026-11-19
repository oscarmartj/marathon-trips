// Disputes and chargebacks through the simulator (plan docs/plans/4.5-refunds-disputes.md, sections 5, 6, 7 and 14).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISPUTE_STATUS_PAIRS, disputeTaskRef } from '../../../src/modules/payments/core/disputes.service';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { PaymentRemindersService } from '../../../src/modules/payments/core/reminders.service';
import { coverageLostTaskRef } from '../../../src/modules/payments/core/refunds.service';
import { ProviderAccountsService } from '../../../src/modules/payments/core/accounts.service';
import { ErasureService } from '../../../src/modules/privacy';
import { SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { CATALOGUE_AND_PRICING, Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { balancesOf, connect, ledgerOf, txError } from '../../support/ledger';
import { pricedWorld } from '../../support/pricing';
import {
  ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount,
} from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const check = (bookingId: string) => t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] });
const statusOf = async (id: string) => (await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const disputesOf = (bookingId: string) => t.prisma.dispute.findMany({ where: { bookingId } });
const send = (ref: string, over: Parameters<typeof sim.disputeEvent>[3] = {}, a: SimAccount = acc) => deliver(t, a, sim.disputeEvent(a.secret, a.id, ref, over));
const reviewOpen = async (bookingId: string) => (await t.prisma.task.count({ where: { sourceRef: coverageLostTaskRef(bookingId), status: 'open' } })) > 0;

async function pay(reference: string, bookingId: string, upTo?: number, a: SimAccount = acc) {
  expect((await c.pay(reference, { method: 'card', ...(upTo ? { upToSequence: upTo } : {}) })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  sim.settle(a.id, p.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, a, await eventFor(t, a, p.id))).outcome).toBe('processed');
  return t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
}

async function booking(autoConfirm = true) {
  const w = await pricedWorld(admin);
  if (!autoConfirm) await t.prisma.$executeRawUnsafe(`UPDATE packages SET "autoConfirmOnDeposit" = false WHERE id = $1::uuid`, w.pkg.id);
  return approvedBooking(t, admin, w, c);
}

describe('the dispute status as the database keeps it', () => {
  it('dispute_status_pairs_code_matches_trigger: the code and the trigger of 0035 allow the same moves', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId);
    const states = ['open', 'evidence_submitted', 'won', 'lost', 'closed'] as const;
    const owner = await connect('owner');
    try {
      for (const from of states) {
        for (const to of states) {
          if (from === to) continue;
          const allowed = DISPUTE_STATUS_PAIRS.some(([a, b]) => a === from && b === to);
          const id = randomUUID();
          // One transaction, always rolled back: the move is tried after a savepoint.
          await owner.query('BEGIN');
          await owner.query(`INSERT INTO disputes (id, "paymentId", "bookingId", "providerAccountId", mode, currency, "providerDisputeRef", "amountMinor", "reasonCode", status, "updatedAt")
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'test', 'AUD', $5, 100, 'other', $6::"DisputeStatus", now())`, [id, p.id, bookingId, acc.id, `dp_matrix_${id}`, from]);
          let ok = true;
          try {
            await owner.query(`UPDATE disputes SET status = $2::"DisputeStatus", version = version + 1 WHERE id = $1::uuid`, [id, to]);
          } catch {
            ok = false;
          }
          await owner.query('ROLLBACK');
          expect(ok, `${from} → ${to}`).toBe(allowed);
        }
      }
    } finally {
      await owner.end();
    }
  });

  it('chargeback_posting_requires_dispute and ledger_booking_must_match_dispute', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId);
    const other = await booking();
    const db = await connect('app');
    try {
      const noDispute = await txError(db, [[
        `WITH t AS (INSERT INTO ledger_transactions (id, kind, mode, "bookingId", "idempotencyKey", description, "contentSha256") VALUES (gen_random_uuid(), 'chargeback', 'test', $1::uuid, $2, 'x', repeat('a', 64)) RETURNING id)
         SELECT 1`, [bookingId, `test:${randomUUID()}`],
      ]]);
      expect(noDispute).toBe('23514');
      const d = sim.openDispute(acc.id, p.providerPaymentRef!);
      await send(d.ref);
      const dispute = (await disputesOf(bookingId))[0]!;
      const wrongBooking = await txError(db, [[
        `INSERT INTO ledger_transactions (id, kind, mode, "bookingId", "disputeId", "idempotencyKey", description, "contentSha256") VALUES (gen_random_uuid(), 'chargeback', 'test', $1::uuid, $2::uuid, $3, 'x', repeat('a', 64))`,
        [other.bookingId, dispute.id, `test:${randomUUID()}`],
      ]]);
      expect(wrongBooking).toBe('23514');
      expect(await txError(db, [[`DELETE FROM disputes WHERE id = $1::uuid`, [dispute.id]]])).not.toBeNull();
      expect(await txError(db, [[`UPDATE disputes SET "amountMinor" = 1, version = version + 1 WHERE id = $1::uuid`, [dispute.id]]])).not.toBeNull();
    } finally {
      await db.end();
    }
  });
});

describe('dispute events (plan 4.5, 5.3)', () => {
  it('dispute_created_and_funds_withdrawn_posts_once: the same facts under three events post one chargeback', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId);
    const d = sim.openDispute(acc.id, p.providerPaymentRef!);
    expect((await send(d.ref)).outcome).toBe('processed');
    sim.moveDispute(acc.id, d.ref, { fundsWithdrawn: true });
    expect((await send(d.ref)).outcome).toBe('processed');
    expect((await send(d.ref)).outcome).toBe('processed');
    const rows = await disputesOf(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'open', amountMinor: p.amountMinor, reasonCode: 'fraudulent' });
    expect(rows[0]!.fundsWithdrawnAt).not.toBeNull();
    const cb = (await ledgerOf(t, bookingId)).filter((x) => x.idempotencyKey === `chargeback:${rows[0]!.id}:withdrawn`);
    expect(cb).toHaveLength(1);
    expect(cb[0]!.kind).toBe('chargeback');
    expect(cb[0]!.entries.clearing).toBe(-p.amountMinor);
    expect(await t.prisma.webhookEvent.count({ where: { disputeId: rows[0]!.id, status: 'processed' } })).toBe(3);
    expect(await t.prisma.task.count({ where: { sourceRef: disputeTaskRef(rows[0]!.id) } })).toBe(1);
    expect(await check(bookingId)).toEqual([]);
  });

  it('dispute_webhook_duplicate_out_of_order and dispute_contradictory_outcome_goes_to_review', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId);
    const d = sim.openDispute(acc.id, p.providerPaymentRef!, { withdrawn: true, status: 'lost' });
    expect((await send(d.ref)).outcome).toBe('processed');
    // An older "open" event arrives late: the gateway's word now is still lost.
    expect((await send(d.ref, { status: 'open', fundsWithdrawn: false })).outcome).toBe('processed');
    expect((await disputesOf(bookingId))[0]).toMatchObject({ status: 'lost' });
    // The gateway now says won: a different final outcome is never applied, Oscar checks it.
    sim.moveDispute(acc.id, d.ref, { status: 'won' });
    const w = sim.disputeEvent(acc.secret, acc.id, d.ref);
    expect((await deliver(t, acc, w)).outcome).toBe('processed');
    const row = (await disputesOf(bookingId))[0]!;
    expect(row.status).toBe('lost');
    const ev = await t.prisma.webhookEvent.findFirstOrThrow({ where: { providerEventId: w.eventId } });
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:dispute_review:${ev.id}` } })).toBe(1);
    expect((await ledgerOf(t, bookingId)).filter((x) => x.kind === 'chargeback')).toHaveLength(1);
  });

  it('a gateway that does not confirm the dispute leaves the event failed and retryable', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId);
    const d = sim.openDispute(acc.id, p.providerPaymentRef!);
    sim.failNextDisputeRetrieve(acc.id);
    const r = await deliver(t, acc, sim.disputeEvent(acc.secret, acc.id, d.ref)).catch((e: unknown) => ({ error: e }));
    expect('error' in r).toBe(true);
    expect(await disputesOf(bookingId)).toHaveLength(0);
  });

  it('dispute_unmatched_payment_ignored_with_task and dispute_metadata_id_from_other_account_not_matched', async () => {
    const { reference, bookingId } = await booking();
    const ours = await pay(reference, bookingId);
    const other = await simulatorAccount(t);
    const gateway = t.app.get(ProviderGateway);
    // A payment on another account that carries our payment's id: never ours.
    const foreign = await gateway.call(other.id, 'retrieve', (pr, ctx) => pr.createPayment(ctx, {
      amount: { amountMinor: ours.amountMinor, currency: 'AUD' }, method: 'card', idempotencyKey: `test:${randomUUID()}`, metadata: { paymentId: ours.id, bookingId },
      returnUrl: 'http://localhost:3000/payments/return', customerCountry: 'AU', createdAt: new Date(),
    }));
    sim.settle(other.id, foreign.ref, 'succeeded');
    const d = sim.openDispute(other.id, foreign.ref);
    const out = await send(d.ref, {}, other);
    expect(out.outcome).toBe('ignored');
    const ev = await t.prisma.webhookEvent.findFirstOrThrow({ where: { providerAccountId: other.id }, orderBy: { receivedAt: 'desc' } });
    expect(ev.errorCode).toBe('unknown_payment');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:unknown_event:${ev.id}` } })).toBe(1);
    expect(await disputesOf(bookingId)).toHaveLength(0);
    await onlyAccount(t, acc.id);
  });

  it('dispute_event_before_payment_success_syncs_payment_first', async () => {
    const { reference, bookingId } = await booking();
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const p = (await t.prisma.payment.findMany({ where: { bookingId } }))[0]!;
    sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
    const d = sim.openDispute(acc.id, p.providerPaymentRef!);
    expect((await send(d.ref)).outcome).toBe('processed');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('succeeded');
    const keys = (await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey);
    expect(keys[0]).toBe(`payment:${p.id}:succeeded`);
    expect(await disputesOf(bookingId)).toHaveLength(1);
  });

  it('archived_account_still_processes_dispute_webhook and archive_rejected_with_open_dispute', async () => {
    const a = await simulatorAccount(t);
    await onlyAccount(t, a.id);
    try {
      const { reference, bookingId } = await booking();
      const p = await pay(reference, bookingId, undefined, a);
      const d = sim.openDispute(a.id, p.providerPaymentRef!);
      expect((await send(d.ref, {}, a)).outcome).toBe('processed');
      await t.prisma.providerAccount.update({ where: { id: a.id }, data: { status: 'retired' } });
      const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: a.id } });
      const blocked = await admin.post(`/admin/payments/provider-accounts/${a.id}/status`, { version: row.version, status: 'archived' });
      expect([blocked.status, blocked.body.code]).toEqual([409, 'archive_blocked']);
      expect(blocked.body.reasons).toContain('open_dispute');
      const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
      await owner.connect();
      await owner.query(`UPDATE provider_accounts SET status = 'archived' WHERE id = $1::uuid`, [a.id]);
      await owner.end();
      sim.moveDispute(a.id, d.ref, { status: 'won' });
      expect((await send(d.ref, {}, a)).outcome).toBe('processed');
      expect((await disputesOf(bookingId))[0]!.status).toBe('won');
    } finally {
      await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'active' } });
    }
  });
});

describe('what money out means for the booking (plan 0.1, 6.2 and P7; plan 4.5, section 7 and 14.6)', () => {
  it('lost_chargeback_on_deposit_flags_unpaid_and_blocks_confirm and lost_chargeback_reopens_item_pending', async () => {
    const { reference, bookingId } = await booking(false);
    const p = await pay(reference, bookingId);
    expect(await statusOf(bookingId)).toBe('deposit_paid');
    const d = sim.openDispute(acc.id, p.providerPaymentRef!, { withdrawn: true, status: 'lost' });
    expect((await send(d.ref)).outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('deposit_paid');
    const v = await admin.get(`/admin/payments/bookings/${bookingId}/refunds`);
    expect(v.body.depositReversed).toBe(true);
    const items = (await admin.get(`/admin/payments/bookings/${bookingId}`)).body.allocation.items as Array<{ paidMinor: string }>;
    expect(items.every((i) => i.paidMinor === '0')).toBe(true);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const confirm = await admin.post(`/admin/bookings/${bookingId}/confirm`, { version: b.version });
    expect([confirm.status, confirm.body.code]).toEqual([409, 'deposit_not_covered']);
    expect(await reviewOpen(bookingId)).toBe(true);
    const again = await c.pay(reference, { method: 'card' });
    expect([again.status, again.body.code]).toEqual([409, 'booking_payment_under_review']);
    expect(await check(bookingId)).toEqual([]);
  });

  it('refund_or_chargeback_moves_balance_paid_to_confirmed, then reinstated_chargeback_moves_to_balance_paid', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId, 2);
    expect(await statusOf(bookingId)).toBe('balance_paid');
    const d = sim.openDispute(acc.id, p.providerPaymentRef!, { amountMinor: 1000n, withdrawn: true });
    expect((await send(d.ref)).outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('confirmed');
    expect(await reviewOpen(bookingId)).toBe(true);
    sim.moveDispute(acc.id, d.ref, { status: 'won', fundsReinstated: true });
    expect((await send(d.ref)).outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('balance_paid');
    const keys = (await ledgerOf(t, bookingId)).map((x) => [x.idempotencyKey, x.kind]);
    const id = (await disputesOf(bookingId))[0]!.id;
    expect(keys).toContainEqual([`chargeback:${id}:withdrawn`, 'chargeback']);
    expect(keys).toContainEqual([`chargeback:${id}:reinstated`, 'reversal']);
    expect(await check(bookingId)).toEqual([]);
  });

  it('chargeback_of_deposit_payment_reopens_last_item: two payments, the deposit one charged back (the P7 deviation, fixed here)', async () => {
    const { reference, bookingId } = await booking();
    const deposit = await pay(reference, bookingId, 1);
    const balance = await pay(reference, bookingId, 2);
    expect(await statusOf(bookingId)).toBe('balance_paid');
    const d = sim.openDispute(acc.id, deposit.providerPaymentRef!, { withdrawn: true, status: 'lost' });
    expect((await send(d.ref)).outcome).toBe('processed');
    const items = ((await admin.get(`/admin/payments/bookings/${bookingId}`)).body.allocation.items as Array<{ sequence: number; amountMinor: string; paidMinor: string }>).sort((a, b) => a.sequence - b.sequence);
    // What is left (the balance payment's money) fills the plan from the first item: the money taken back shows on the
    // last items, whichever payment it came from (plan 4.5, 12.1). Here that leaves the deposit item filled first.
    let left = balance.amountMinor;
    for (const i of items) {
      const want = left >= BigInt(i.amountMinor) ? BigInt(i.amountMinor) : left;
      expect(BigInt(i.paidMinor), `item ${i.sequence}`).toBe(want);
      left -= want;
    }
    expect(items.reduce((s, i) => s + BigInt(i.paidMinor), 0n)).toBe(balance.amountMinor);
    expect(await statusOf(bookingId)).toBe('confirmed');
    // Under review: no reminder goes to a customer who disputed a payment.
    expect(await reviewOpen(bookingId)).toBe(true);
    const item = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId, state: 'active' }, orderBy: { sequence: 'desc' } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
    expect(await t.app.get(PaymentRemindersService).remind(item.id, bookingId, [14, 7, 3], today)).toBe('payment_under_review');
    void balance;
  });

  it('dispute_blocks_reminders_links_and_charges while it is open, without any money moved', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId, 1);
    const d = sim.openDispute(acc.id, p.providerPaymentRef!);
    expect((await send(d.ref)).outcome).toBe('processed');
    expect(await reviewOpen(bookingId)).toBe(false);
    const res = await c.pay(reference, { method: 'card' });
    expect([res.status, res.body.code]).toEqual([409, 'booking_payment_under_review']);
    const link = await admin.post(`/admin/payments/bookings/${bookingId}/payment-links`, {});
    expect([link.status, link.body.code]).toEqual([409, 'booking_payment_under_review']);
    const item = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId, state: 'active' }, orderBy: { sequence: 'desc' } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
    expect(await t.app.get(PaymentRemindersService).remind(item.id, bookingId, [14, 7, 3], today)).toBe('payment_under_review');
    // Refunding a disputed payment from the app is refused.
    const refund = await admin.post(`/admin/payments/payments/${p.id}/refunds`, { paymentVersion: (await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).version, purpose: 'overpayment_return', reason: 'Testing' }).set('Idempotency-Key', randomUUID());
    expect([refund.status, refund.body.code]).toEqual([409, 'refund_of_disputed_payment_rejected']);
  });

  it('chargeback_after_full_refund_posts_receivable; negative_collected_payable_excludes_receivable', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId, 1);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    // The customer gets everything back at the gateway, then disputes the payment anyway.
    const ext = sim.gatewayRefund(acc.id, p.providerPaymentRef!, p.amountMinor);
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, ext.ref))).outcome).toBe('processed');
    const d = sim.openDispute(acc.id, p.providerPaymentRef!, { withdrawn: true, status: 'lost' });
    expect((await send(d.ref)).outcome).toBe('processed');
    const bal = await balancesOf(t, bookingId);
    expect(bal).toEqual({ fundsMinor: 0n, overpaymentsMinor: 0n, receivableMinor: p.amountMinor });
    expect(await check(bookingId)).toEqual([]);
    // What the customer is asked to pay is the plan, never the receivable.
    const plan = await c.plan(reference);
    const owed = (await t.prisma.paymentScheduleItem.findMany({ where: { bookingId, state: 'active' } })).reduce((s, i) => s + i.amountMinor, 0n);
    expect([BigInt(plan.body.outstandingMinor), plan.body.collectedMinor]).toEqual([owed, "0"]);
    expect(await reviewOpen(bookingId)).toBe(true);
    void b;
  });
});

describe('the evidence package (plan 4.5, section 6) and erasure (plan review, 7)', () => {
  async function forceStatus(bookingId: string, status: 'completed'): Promise<void> {
    const db = await connect('owner');
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE bookings DISABLE TRIGGER USER');
      await db.query(`UPDATE bookings SET status = $2::"BookingStatus" WHERE id = $1::uuid`, [bookingId, status]);
      await db.query('ALTER TABLE bookings ENABLE TRIGGER USER');
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }

  it('evidence_package_contains_terms_snapshot_and_emails; evidence_requires_step_up_and_is_audited; mark_evidence_submitted_once', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId);
    const d = sim.openDispute(acc.id, p.providerPaymentRef!, { reasonCode: 'product_not_received' });
    await send(d.ref);
    const dispute = (await disputesOf(bookingId))[0]!;
    const stale = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
    await t.prisma.session.updateMany({ where: { userId: stale.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    expect((await stale.get(`/admin/payments/disputes/${dispute.id}/evidence`)).body.code).toBe('step_up_required');
    const res = await admin.get(`/admin/payments/disputes/${dispute.id}/evidence`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const pack = JSON.parse(res.text) as Record<string, unknown> & { termsAccepted: Array<{ acceptedAt: string; body: string }>; configurationAndPrice: Array<{ totalMinor: string }>; emailsSent: unknown[]; customer: { erased: boolean; email?: string }; dispute: { reasonCode: string } };
    expect(pack.termsAccepted.length).toBeGreaterThan(0);
    expect(pack.termsAccepted[0]!.acceptedAt).toMatch(/^\d{4}-/);
    expect(pack.termsAccepted[0]!.body.length).toBeGreaterThan(0);
    expect(pack.configurationAndPrice[0]!.totalMinor).toMatch(/^\d+$/);
    expect(Array.isArray(pack.emailsSent)).toBe(true);
    expect(pack.customer.erased).toBe(false);
    expect(pack.dispute.reasonCode).toBe('product_not_received');
    expect(res.text).not.toMatch(/sim_test_|whsec_|card_number|cvc/i);
    expect(await t.prisma.auditLog.count({ where: { entityId: dispute.id, action: 'payments.dispute.evidence_downloaded' } })).toBe(1);
    const marked = await admin.post(`/admin/payments/disputes/${dispute.id}/evidence-submitted`, { version: dispute.version });
    expect([marked.status, marked.body.status]).toEqual([200, 'evidence_submitted']);
    const twice = await admin.post(`/admin/payments/disputes/${dispute.id}/evidence-submitted`, { version: marked.body.version });
    expect([twice.status, twice.body.code]).toEqual([409, 'dispute_not_open']);
    expect((await t.prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })).evidenceSubmittedById).toBe((admin as unknown as { staff: { id: string } }).staff.id);
  });

  it('erasure_refused_with_open_dispute and erasure_refused_with_open_dispute_as_payer; evidence_package_after_erasure_has_no_personal_data', async () => {
    const keep = c;
    c = await payingCustomer(t);
    try {
      const { reference, bookingId } = await booking();
      const p = await pay(reference, bookingId, 2);
      await forceStatus(bookingId, 'completed');
      const customerId = (await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).customerId;
      const d = sim.openDispute(acc.id, p.providerPaymentRef!);
      await send(d.ref);
      const reason = (id: string) => t.app.get(ErasureService).blockedBy(t.prisma, id);
      expect(await reason(customerId)).toBe('open_dispute');
      // The payer of a payment is held too, even when the booking is someone else's.
      const payer = await payingCustomer(t);
      const theirs = await approvedBooking(t, admin, await pricedWorld(admin), payer);
      const tb = await t.prisma.booking.findUniqueOrThrow({ where: { id: theirs.bookingId } });
      expect((await admin.post(`/admin/bookings/${tb.id}/cancel`, { version: tb.version, reason: 'Not needed' })).status).toBe(200);
      const payerId = tb.customerId;
      expect(await reason(payerId)).toBeNull();
      const owner = await connect('owner');
      try {
        await owner.query('BEGIN');
        await owner.query('ALTER TABLE payments DISABLE TRIGGER payments_guard');
        await owner.query(`UPDATE payments SET "payerCustomerId" = $2::uuid WHERE id = $1::uuid`, [p.id, payerId]);
        await owner.query('ALTER TABLE payments ENABLE TRIGGER payments_guard');
        await owner.query('COMMIT');
      } finally {
        await owner.end();
      }
      expect(await reason(payerId)).toBe('open_dispute');
      // Won: the customer may be erased; the package then holds nothing personal.
      sim.moveDispute(acc.id, d.ref, { status: 'won' });
      await send(d.ref);
      expect(await reason(customerId)).toBeNull();
      expect((await t.app.get(ErasureService).erase(customerId, SYSTEM_ACTOR)).status).toBe('completed');
      const dispute = (await disputesOf(bookingId))[0]!;
      const res = await admin.get(`/admin/payments/disputes/${dispute.id}/evidence`);
      const pack = JSON.parse(res.text) as { customer: { erased: boolean }; emailsSent: Array<{ to: unknown; subject: unknown }> };
      expect(pack.customer).toEqual({ erased: true });
      expect(pack.emailsSent.every((e) => e.to === null && e.subject === null)).toBe(true);
      expect(res.text).not.toContain(c.email);
    } finally {
      c = keep;
    }
  });
});

describe('review of the code (M1, M2)', () => {
  it('receivable_blocks_checkout_until_settled: a debt beyond the plan is never charged at checkout, even with the task closed', async () => {
    const manualId = (await t.app.get(ProviderAccountsService).createManualAccount({ displayName: 'Debt transfer' })).id;
    try {
      const { reference, bookingId } = await booking();
      const p = await pay(reference, bookingId, 1);
      const ext = sim.gatewayRefund(acc.id, p.providerPaymentRef!, p.amountMinor);
      await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, ext.ref));
      const d = sim.openDispute(acc.id, p.providerPaymentRef!, { withdrawn: true, status: 'lost' });
      await send(d.ref);
      expect((await balancesOf(t, bookingId)).receivableMinor).toBe(p.amountMinor);
      // Oscar closes the review tasks without settling the debt: checkout still says no (it would only pay the debt).
      await t.prisma.task.updateMany({ where: { entityId: { in: [bookingId] }, status: 'open' }, data: { status: 'done' } });
      expect(await reviewOpen(bookingId)).toBe(false);
      const refused = await c.pay(reference, { method: 'card' });
      expect([refused.status, refused.body.code]).toEqual([409, 'booking_payment_under_review']);
      // Second payment: Oscar records the customer's transfer that pays the debt. Only then checkout asks for the plan.
      const paid = await admin.post(`/admin/payments/bookings/${bookingId}/inbound-payments`, { amountMinor: p.amountMinor.toString(), reference: `DEBT-${Date.now().toString(36).toUpperCase()}` });
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect((await balancesOf(t, bookingId)).receivableMinor).toBe(0n);
      const plan = await c.plan(reference);
      const owed = (await t.prisma.paymentScheduleItem.findMany({ where: { bookingId, state: 'active' } })).reduce((s, i) => s + i.amountMinor, 0n);
      expect(BigInt(plan.body.outstandingMinor)).toBe(owed);
      expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
      expect(await check(bookingId)).toEqual([]);
    } finally {
      await t.prisma.providerAccount.update({ where: { id: manualId }, data: { status: 'paused' } });
    }
  });

  it('ledger_check_includes_chargebacks_and_receivable: a chargeback the ledger does not hold is found', async () => {
    const { reference, bookingId } = await booking();
    const p = await pay(reference, bookingId);
    const d = sim.openDispute(acc.id, p.providerPaymentRef!, { withdrawn: true });
    await send(d.ref);
    expect(await check(bookingId)).toEqual([]);
    const dispute = (await disputesOf(bookingId))[0]!;
    const owner = await connect('owner');
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE disputes DISABLE TRIGGER disputes_guard');
      await owner.query(`UPDATE disputes SET "fundsReinstatedAt" = now() WHERE id = $1::uuid`, [dispute.id]);
      await owner.query('ALTER TABLE disputes ENABLE TRIGGER disputes_guard');
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    const found = (await check(bookingId)).map((f) => f.kind);
    expect(found).toContain('missing_chargeback_posting');
    expect(found).toContain('booking_total');
  });
});
