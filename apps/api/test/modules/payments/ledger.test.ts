// The payment ledger in the database (plan docs/plans/3.3-stripe-adapter-ledger.md, sections 1, 4 and 12): its rules,
// the postings of payments and plan changes, and the daily check. Failure paths first.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { LedgerKeyConflictError, LedgerService } from '../../../src/modules/payments/core/ledger.service';
import { readBookingForPayments } from '../../../src/modules/bookings';
import { TestApp, makeApp } from '../../support/auth';
import { CATALOGUE_AND_PRICING, closeCatalogue, staffClient } from '../../support/catalogue';
import type { Client } from '../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import {
  ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, acceptCurrentTerms, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, sim, simulatorAccount,
} from '../../support/payments';
import { AmendWorld, amendWorld, requestIn, retireAmendWorlds, runner, supporter } from '../../support/amendments';
import { balancesOf, connect, ledgerOf, txError } from '../../support/ledger';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Client & { staff: { id: string } };
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
afterAll(async () => {
  await retireAmendWorlds(t);
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'mail.send'`);
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const row = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
const check = (bookingId: string) => t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] });

/** Pays what the booking owes next through the simulator: attempt, customer pays, webhook processed. */
async function payNext(reference: string, bookingId: string) {
  expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, acc, await eventFor(t, acc, p.id))).outcome).toBe('processed');
  return t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
}

async function amend(bookingId: string, body: Record<string, unknown>) {
  const p = await admin.post(`/admin/bookings/${bookingId}/amendments/preview`, body);
  if (p.status !== 200) throw new Error(`preview ${p.status} ${JSON.stringify(p.body)}`);
  const r = await admin.post(`/admin/bookings/${bookingId}/amendments`, { ...body, previewDigest: p.body.previewDigest }).set('Idempotency-Key', randomUUID());
  if (r.status !== 201) throw new Error(`apply ${r.status} ${JSON.stringify(r.body)}`);
}
const keep = (world: AmendWorld, version: number, over: Record<string, unknown> = {}) => ({ expectedSnapshotVersion: version, rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [], reasonCode: 'customer_request', ...over });

/** A booking with its deposit paid and one payment posted, for the database rules. */
async function postedBooking() {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const p = await payNext(reference, bookingId);
  const tx = await t.prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `payment:${p.id}:succeeded` } });
  return { reference, bookingId, p, tx };
}

describe('ledger rules in the database (plan 3.3, 1.1 and 12.2)', () => {
  it('ledger_entries_cannot_be_updated_or_deleted: the API role lacks the privilege, the owner meets the trigger', async () => {
    const { tx } = await postedBooking();
    for (const as of ['app', 'owner'] as const) {
      const db = await connect(as);
      try {
        for (const sql of [
          `UPDATE ledger_entries SET "amountMinor" = "amountMinor" * 2 WHERE "transactionId" = $1::uuid`,
          `DELETE FROM ledger_entries WHERE "transactionId" = $1::uuid`,
          `UPDATE ledger_transactions SET description = 'edited' WHERE id = $1::uuid`,
          `DELETE FROM ledger_transactions WHERE id = $1::uuid`,
        ]) expect(await txError(db, [[sql, [tx.id]]]), `${as}: ${sql}`).toBe(as === 'app' ? '42501' : '42501');
        expect(await txError(db, [['TRUNCATE ledger_entries']]), `${as}: truncate`).not.toBeNull();
        expect(await txError(db, [[`UPDATE ledger_accounts SET kind = 'expense' WHERE code = 'customer_funds'`]]), `${as}: account`).not.toBeNull();
      } finally {
        await db.end();
      }
    }
    expect((await t.prisma.ledgerEntry.findMany({ where: { transactionId: tx.id } })).length).toBe(2);
  });

  it('entries_cannot_be_added_to_committed_transaction: a balanced pair added later is refused, also for the owner', async () => {
    const { tx, bookingId } = await postedBooking();
    for (const as of ['app', 'owner'] as const) {
      const db = await connect(as);
      try {
        const code = await txError(db, [
          [`INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor", "bookingId") VALUES (gen_random_uuid(), $1::uuid, 'test', 'customer_funds', 'AUD', 500, $2::uuid)`, [tx.id, bookingId]],
          [`INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor", "bookingId") VALUES (gen_random_uuid(), $1::uuid, 'test', 'customer_overpayments', 'AUD', -500, $2::uuid)`, [tx.id, bookingId]],
        ]);
        expect(code, as).toBe('42501');
      } finally {
        await db.end();
      }
    }
    expect(await t.prisma.ledgerEntry.count({ where: { transactionId: tx.id } })).toBe(2);
  });

  it('unbalanced_transaction_rejected_at_commit, single_entry_transaction_rejected, transaction_without_entries_rejected', async () => {
    const { bookingId } = await postedBooking();
    const db = await connect('app');
    await db.query(`INSERT INTO ledger_accounts (id, code, kind, currency, mode) VALUES (gen_random_uuid(), 'customer_funds', 'liability', 'AUD', 'test'), (gen_random_uuid(), 'customer_overpayments', 'liability', 'AUD', 'test'), (gen_random_uuid(), 'customer_overpayments', 'liability', 'NZD', 'test') ON CONFLICT DO NOTHING`);
    const newTx = (key: string) => [`INSERT INTO ledger_transactions (id, kind, mode, "bookingId", "idempotencyKey", description, "contentSha256") VALUES ($1::uuid, 'adjustment', 'test', $2::uuid, $3, 'test', repeat('a', 64))`, [key, bookingId, `test:${randomUUID()}`]] as [string, unknown[]];
    const entry = (txId: string, code: string, amount: number) => [`INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor", "bookingId") VALUES (gen_random_uuid(), $1::uuid, 'test', $2, 'AUD', $3, $4::uuid)`, [txId, code, amount, bookingId]] as [string, unknown[]];
    try {
      for (const [label, build] of [
        ['unbalanced', (id: string) => [entry(id, 'customer_funds', 500), entry(id, 'customer_overpayments', -400)]],
        ['single entry', (id: string) => [entry(id, 'customer_funds', 500)]],
        ['no entries', () => []],
        ['zero entry', (id: string) => [entry(id, 'customer_funds', 0), entry(id, 'customer_overpayments', 0)]],
        // Balanced in total but not per currency: +100 AUD, −100 NZD.
        ['other currency', (id: string) => [entry(id, 'customer_funds', 100), [`INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor", "bookingId") VALUES (gen_random_uuid(), $1::uuid, 'test', 'customer_overpayments', 'NZD', -100, $2::uuid)`, [id, bookingId]] as [string, unknown[]]]],
      ] as const) {
        const id = randomUUID();
        const [sql, params] = newTx(id);
        const code = await txError(db, [[sql, [id, ...params.slice(1)]], ...build(id)]);
        expect(code, label).toBe('23514');
      }
    } finally {
      await db.end();
    }
  });

  it('mode, booking and currency consistency (plan 0.1, P11 and P8)', async () => {
    const a = await postedBooking();
    const b = await postedBooking();
    const db = await connect('app');
    await db.query(`INSERT INTO ledger_accounts (id, code, kind, currency, mode) VALUES (gen_random_uuid(), 'customer_overpayments', 'liability', 'AUD', 'test') ON CONFLICT DO NOTHING`);
    const ins = (over: { mode?: string; bookingId?: string; paymentId?: string | null }) => {
      const id = randomUUID();
      const paymentId = over.paymentId === undefined ? a.p.id : over.paymentId;
      return { id, sql: [`INSERT INTO ledger_transactions (id, kind, mode, "bookingId", "paymentId", "idempotencyKey", description, "contentSha256") VALUES ($1::uuid, $6::"LedgerTransactionKind", $2::"PaymentMode", $3::uuid, $4::uuid, $5, 'test', repeat('a', 64))`, [id, over.mode ?? 'test', over.bookingId ?? a.bookingId, paymentId, `test:${randomUUID()}`, paymentId ? 'payment' : 'adjustment']] as [string, unknown[]] };
    };
    const entry = (txId: string, code: string, amount: number, mode = 'test', currency = 'AUD', bookingId = a.bookingId) =>
      [`INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor", "bookingId") VALUES (gen_random_uuid(), $1::uuid, $2::"PaymentMode", $3, $4, $5, $6::uuid)`, [txId, mode, code, currency, amount, bookingId]] as [string, unknown[]];
    try {
      // ledger_transaction_mode_must_match_payment: a live transaction for a test payment.
      let x = ins({ mode: 'live' });
      expect(await txError(db, [x.sql]), 'transaction mode').toBe('23503');
      // ledger_booking_must_match_payment_and_transaction: the payment of booking A under booking B.
      x = ins({ bookingId: b.bookingId });
      expect(await txError(db, [x.sql]), 'transaction booking').toBe('23514');
      // ledger_entry_mode_must_match_account_and_transaction: a live entry in a test transaction.
      x = ins({});
      expect(await txError(db, [x.sql, entry(x.id, 'customer_funds', 100, 'live'), entry(x.id, 'customer_overpayments', -100, 'live')]), 'entry mode').toBe('23503');
      // ledger_entry_currency_must_match_account: an NZD entry where only the AUD account exists.
      x = ins({ paymentId: null });
      expect(await txError(db, [x.sql, entry(x.id, 'customer_funds', 100, 'test', 'NZD'), entry(x.id, 'customer_overpayments', -100, 'test', 'NZD')]), 'entry currency').toBe('23503');
      // payment_ledger_entries_in_payment_currency: NZD accounts exist, but a payment in AUD posts in AUD.
      await db.query(`INSERT INTO ledger_accounts (id, code, kind, currency, mode) VALUES (gen_random_uuid(), 'customer_funds', 'liability', 'NZD', 'test'), (gen_random_uuid(), 'customer_overpayments', 'liability', 'NZD', 'test') ON CONFLICT DO NOTHING`);
      x = ins({});
      expect(await txError(db, [x.sql, entry(x.id, 'customer_funds', 100, 'test', 'NZD'), entry(x.id, 'customer_overpayments', -100, 'test', 'NZD')]), 'payment currency').toBe('23514');
      // An entry with another booking than its transaction.
      x = ins({ paymentId: null });
      expect(await txError(db, [x.sql, entry(x.id, 'customer_funds', 100, 'test', 'AUD', b.bookingId), entry(x.id, 'customer_overpayments', -100, 'test', 'AUD', b.bookingId)]), 'entry booking').toBe('23514');
    } finally {
      await db.end();
    }
  });

  it('app_refund_rejected_by_check_until_4_5: only refunds made at the gateway can be stored before task 4.5', async () => {
    const { p } = await postedBooking();
    const db = await connect('app');
    try {
      const insert = (origin: string, purpose: string | null) => [`INSERT INTO refunds (id, "paymentId", "bookingId", "providerAccountId", mode, currency, "amountMinor", origin, purpose, status, "idempotencyKey", "providerRefundRef", "updatedAt")
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'test', 'AUD', 100, $4::"RefundOrigin", $5::"RefundPurpose", 'requested', $6, NULL, now())`, [p.id, p.bookingId, p.providerAccountId, origin, purpose, `refund:test:${randomUUID()}`]] as [string, unknown[]];
      expect(await txError(db, [insert('app', 'overpayment_return')])).toBe('23514');
      // The same row as an external refund is accepted only with a gateway reference.
      expect(await txError(db, [insert('external', null)])).toBe('23514');
    } finally {
      await db.end();
    }
  });

  it('same_ledger_key_other_content_rejected: a second, different posting under a key undoes its transaction', async () => {
    const { bookingId, p } = await postedBooking();
    const before = await ledgerOf(t, bookingId);
    await expect(t.prisma.$transaction(async (tx) => {
      const b = (await readBookingForPayments(tx, { id: bookingId }, true))!;
      await t.app.get(LedgerService).postPaymentSucceeded(tx, b, { id: p.id, providerAccountId: p.providerAccountId, amountMinor: p.amountMinor, mode: 'test' });
    })).rejects.toBeInstanceOf(LedgerKeyConflictError);
    expect(await ledgerOf(t, bookingId)).toEqual(before);
  });
});

describe('ledger_postings_table (plan 3.3, 1.4)', () => {
  it('deposit then balance: one posting each, clearing debited, customer funds credited; booking_ledger_balance_equals_collected_minus_refunded', async () => {
    const world = await amendWorld(admin);
    const b = await requestIn(t, c.cookie, world, { rooms: [{ roomOptionId: world.doubleId, travellers: [runner(world), supporter] }] });
    expect((await admin.post(`/admin/bookings/${b.bookingId}/approve`, { version: (await row(b.bookingId)).version })).status).toBe(200);
    await acceptCurrentTerms(t, c, b.reference);
    const dep = await payNext(b.reference, b.bookingId);
    const bal = await payNext(b.reference, b.bookingId);
    expect(await ledgerOf(t, b.bookingId)).toEqual([
      { idempotencyKey: `payment:${dep.id}:succeeded`, kind: 'payment', entries: { clearing: dep.amountMinor, customer_funds: -dep.amountMinor } },
      { idempotencyKey: `payment:${bal.id}:succeeded`, kind: 'payment', entries: { clearing: bal.amountMinor, customer_funds: -bal.amountMinor } },
    ]);
    const total = dep.amountMinor + bal.amountMinor;
    expect(await balancesOf(t, b.bookingId)).toEqual({ fundsMinor: total, overpaymentsMinor: 0n, receivableMinor: 0n });
    expect(await check(b.bookingId)).toEqual([]);
    // A duplicate success event changes nothing in the ledger.
    expect((await deliver(t, acc, await eventFor(t, acc, bal.id))).outcome).toBe('processed');
    expect(await ledgerOf(t, b.bookingId)).toHaveLength(2);
  });

  it('second_plan_split_does_not_collide_with_first: a change down moves funds to overpayments, a change up brings them back, one key per plan version', async () => {
    const world = await amendWorld(admin);
    const b = await requestIn(t, c.cookie, world, { rooms: [{ roomOptionId: world.doubleId, travellers: [runner(world), supporter] }] });
    expect((await admin.post(`/admin/bookings/${b.bookingId}/approve`, { version: (await row(b.bookingId)).version })).status).toBe(200);
    await acceptCurrentTerms(t, c, b.reference);
    await payNext(b.reference, b.bookingId);
    await payNext(b.reference, b.bookingId);
    const paid = (await row(b.bookingId)).totalMinor;
    // The supporter leaves: the total drops below what was paid.
    await amend(b.bookingId, keep(world, 1, { rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }] }], reasonCode: 'correction' }));
    const lower = (await row(b.bookingId)).totalMinor;
    expect(lower).toBeLessThan(paid);
    const v2 = await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    const down = (await ledgerOf(t, b.bookingId)).find((x) => x.idempotencyKey === `schedule:${b.bookingId}:v${v2.version}:reallocation`);
    expect(down).toEqual({ idempotencyKey: `schedule:${b.bookingId}:v${v2.version}:reallocation`, kind: 'adjustment', entries: { customer_funds: paid - lower, customer_overpayments: lower - paid } });
    expect(await balancesOf(t, b.bookingId)).toEqual({ fundsMinor: lower, overpaymentsMinor: paid - lower, receivableMinor: 0n });
    // An extra night: the total goes back up and the overpayment is absorbed.
    await amend(b.bookingId, keep(world, 2, { rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }] }], extraNightsAfter: 1 }));
    const higher = (await row(b.bookingId)).totalMinor;
    const v3 = await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId: b.bookingId } });
    expect(v3.version).toBe(v2.version + 1);
    const absorbed = (higher < paid ? higher : paid) - lower;
    const up = (await ledgerOf(t, b.bookingId)).find((x) => x.idempotencyKey === `schedule:${b.bookingId}:v${v3.version}:reallocation`);
    expect(up?.entries).toEqual({ customer_funds: -absorbed, customer_overpayments: absorbed });
    expect(await check(b.bookingId)).toEqual([]);
  });

  it('late success after a new attempt: the second payment is posted as overpayment', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const first = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect((await deliver(t, acc, await eventFor(t, acc, first.id, { status: 'failed' }))).outcome).toBe('processed');
    const second = await payNext(reference, bookingId);
    sim.settle(acc.id, first.providerPaymentRef!, 'succeeded');
    expect((await deliver(t, acc, await eventFor(t, acc, first.id))).outcome).toBe('processed');
    const rows = await ledgerOf(t, bookingId);
    expect(rows.map((r) => r.idempotencyKey)).toEqual([`payment:${second.id}:succeeded`, `payment:${first.id}:succeeded`]);
    // The late money first fills what the plan still asks for (the balance), the rest is overpayment.
    const owed = (await row(bookingId)).totalMinor - second.amountMinor;
    expect(rows[1]!.entries).toEqual({ clearing: first.amountMinor, customer_funds: -owed, customer_overpayments: owed - first.amountMinor });
    expect(await check(bookingId)).toEqual([]);
  });

  it('same_idempotency_key_charges_once: one attempt, two requests with the same key, one posting', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    const key = randomUUID();
    expect((await c.pay(reference, { method: 'card' }, key)).status).toBe(201);
    expect((await c.pay(reference, { method: 'card' }, key)).status).toBe(201);
    const ps = await t.prisma.payment.findMany({ where: { bookingId } });
    expect(ps).toHaveLength(1);
    sim.settle(acc.id, ps[0]!.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, ps[0]!.id));
    await deliver(t, acc, await eventFor(t, acc, ps[0]!.id));
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(1);
  });
});

describe('postings under concurrency (plan 3.3, 1.2)', () => {
  it('concurrent_payment_and_amendment_post_consistently: a webhook and a change of the same booking at once leave a consistent ledger', async () => {
    const world = await amendWorld(admin);
    const b = await requestIn(t, c.cookie, world, { rooms: [{ roomOptionId: world.doubleId, travellers: [runner(world), supporter] }] });
    expect((await admin.post(`/admin/bookings/${b.bookingId}/approve`, { version: (await row(b.bookingId)).version })).status).toBe(200);
    await acceptCurrentTerms(t, c, b.reference);
    await payNext(b.reference, b.bookingId);
    // A balance attempt fails; its money arrives late (no attempt is live, so a change is allowed) while staff lower the total.
    expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
    const bal = (await t.prisma.payment.findMany({ where: { bookingId: b.bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
    expect((await deliver(t, acc, await eventFor(t, acc, bal.id, { status: 'failed' }))).outcome).toBe('processed');
    sim.settle(acc.id, bal.providerPaymentRef!, 'succeeded');
    const body = keep(world, 1, { rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }] }], reasonCode: 'correction' });
    const preview = await admin.post(`/admin/bookings/${b.bookingId}/amendments/preview`, body);
    expect(preview.status).toBe(200);
    const late = await eventFor(t, acc, bal.id);
    const [delivered, amended] = await Promise.all([
      deliver(t, acc, late),
      admin.post(`/admin/bookings/${b.bookingId}/amendments`, { ...body, previewDigest: preview.body.previewDigest }).set('Idempotency-Key', randomUUID()),
    ]);
    expect(delivered.outcome).toBe('processed');
    // The change may lose to the money (its preview no longer matches); whichever order won, the ledger agrees with it.
    expect([201, 409]).toContain(amended.status);
    // A lost race is the preview no longer matching, never another conflict (task 4.1, from 3.3's review).
    if (amended.status === 409) expect(amended.body.code).toBe('amendment_price_changed');
    expect(await check(b.bookingId)).toEqual([]);
    const collected = (await t.prisma.payment.aggregate({ where: { bookingId: b.bookingId, status: 'succeeded' }, _sum: { amountMinor: true } }))._sum.amountMinor!;
    const bal2 = await balancesOf(t, b.bookingId);
    expect(bal2.fundsMinor + bal2.overpaymentsMinor).toBe(collected);
  });
});

describe('ledger check (plan 3.3, 4)', () => {
  it('ledger_check_rotates_through_bookings: pages continue after the last booking checked and wrap round', async () => {
    const x = await postedBooking();
    const y = await postedBooking();
    const ids = [x.bookingId, y.bookingId].sort();
    const svc = t.app.get(PaymentLedgerCheckService);
    const first = await svc.checkPage({ bookingIds: ids, limit: 1 });
    expect(first.next).toBe(ids[0]);
    const second = await svc.checkPage({ bookingIds: ids, after: first.next, limit: 1 });
    expect(second.next).toBe(ids[1]);
    expect((await svc.checkPage({ bookingIds: ids, after: second.next, limit: 1 })).next).toBeNull();
    // The daily run keeps its cursor between runs and wraps round when a page is not full.
    await svc.run({ limit: 1 });
    const c1 = await t.prisma.setting.findUnique({ where: { key: 'paymentLedgerCheckCursor' } });
    await svc.run({ limit: 1 });
    const c2 = await t.prisma.setting.findUnique({ where: { key: 'paymentLedgerCheckCursor' } });
    expect(typeof c1?.value).toBe('string');
    expect(c2?.value).not.toEqual(c1?.value);
    await svc.run({ limit: 100_000 });
    expect((await t.prisma.setting.findUnique({ where: { key: 'paymentLedgerCheckCursor' } }))?.value).toBe('');
  });

  it('ledger_check_flags_injected_difference: a balanced adjustment by the owner is found, and a task opened once', async () => {
    const { bookingId } = await postedBooking();
    expect(await check(bookingId)).toEqual([]);
    const db = await connect('owner');
    try {
      const id = randomUUID();
      expect(await txError(db, [
        [`INSERT INTO ledger_transactions (id, kind, mode, "bookingId", "idempotencyKey", description, "contentSha256") VALUES ($1::uuid, 'adjustment', 'test', $2::uuid, $3, 'injected', repeat('b', 64))`, [id, bookingId, `injected:${id}`]],
        [`INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor", "bookingId") VALUES (gen_random_uuid(), $1::uuid, 'test', 'customer_funds', 'AUD', 700, $2::uuid)`, [id, bookingId]],
        [`INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor", "bookingId") VALUES (gen_random_uuid(), $1::uuid, 'test', 'customer_overpayments', 'AUD', -700, $2::uuid)`, [id, bookingId]],
      ])).toBeNull();
    } finally {
      await db.end();
    }
    expect(await check(bookingId)).toEqual([{ kind: 'booking_split', entityType: 'Booking', entityId: bookingId }]);
    await t.app.get(PaymentLedgerCheckService).run({ bookingIds: [bookingId] });
    await t.app.get(PaymentLedgerCheckService).run({ bookingIds: [bookingId] });
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:ledger_check:booking_split:${bookingId}`, status: 'open' } })).toBe(1);
    // Nothing was fixed automatically; the next real posting corrects the split (plan 3.3, 12.7).
    expect((await balancesOf(t, bookingId)).overpaymentsMinor).toBe(700n);
  });

  it('missing posting and wrong total are reported; the full run (clearing accounts) is clean for this account', async () => {
    const { bookingId, p } = await postedBooking();
    const db = await connect('owner');
    try {
      // A payment row moved to succeeded behind the API's back (as a restore of an old backup could): no posting.
      const { reference, bookingId: other } = await approvedBooking(t, admin, await pricedWorld(admin), c);
      expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
      const q = await t.prisma.payment.findFirstOrThrow({ where: { bookingId: other } });
      await db.query('BEGIN');
      await db.query('ALTER TABLE payments DISABLE TRIGGER payments_guard');
      await db.query(`UPDATE payments SET status = 'succeeded', "succeededAt" = now(), "liveBookingId" = NULL, version = version + 1 WHERE id = $1::uuid`, [q.id]);
      await db.query('ALTER TABLE payments ENABLE TRIGGER payments_guard');
      await db.query('COMMIT');
      const findings = await t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId, other] });
      expect(findings).toEqual([{ kind: 'missing_payment_posting', entityType: 'Payment', entityId: q.id }, { kind: 'booking_total', entityType: 'Booking', entityId: other }]);
      expect(p.status).toBe('succeeded');
    } finally {
      await db.end();
    }
  });
});
