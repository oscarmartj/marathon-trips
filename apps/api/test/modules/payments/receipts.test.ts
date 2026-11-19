// Receipts and notes (plan docs/plans/4.6-reconciliation-receipts.md, section 4 and review R7, R12), and the customer
// money report through the API (section 5). GST registration cannot be switched on: no document shows GST.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReceiptsService, contentSha256 } from '../../../src/modules/payments/core/receipts.service';
import type { DocumentContent } from '../../../src/modules/payments/core/receipts.service';
import { runTransaction } from '../../../src/platform/database/transaction';
import { TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { CATALOGUE_AND_PRICING, Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { connect, txError } from '../../support/ledger';
import { pricedWorld } from '../../support/pricing';
import {
  PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount,
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

const receipts = () => t.app.get(ReceiptsService);

async function paid(issue = true) {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, acc, await eventFor(t, acc, p.id))).outcome).toBe('processed');
  if (issue) await receipts().sweep({ bookingIds: [bookingId] });
  return { reference, bookingId, payment: await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } }) };
}

const seq = async () => (await t.prisma.numberSequence.findUniqueOrThrow({ where: { key: 'receipts:test' } })).nextValue;
const num = (n: string) => BigInt(n.slice(5));

describe('issuing (plan 4.6, 4.1, 4.3, 4.4)', () => {
  it('receipt_issued_once_per_payment: the sweep and the consumer, repeated, give one receipt and one number', async () => {
    const { bookingId, payment } = await paid(false);
    const event = await t.prisma.outboxEvent.findFirstOrThrow({ where: { type: 'payments.payment.succeeded', aggregateId: payment.id } });
    const delivered = { ...event, schemaVersion: event.schemaVersion, payload: event.payload, aggregateVersion: event.aggregateVersion, actorId: event.actorId };
    await t.prisma.$transaction((tx) => receipts().onEvent(delivered as never, tx));
    const before = await seq();
    await t.prisma.$transaction((tx) => receipts().onEvent(delivered as never, tx));
    expect(await receipts().sweep({ bookingIds: [bookingId] })).toBe(0);
    await Promise.all([1, 2, 3].map(() => runTransaction(t.prisma, (tx) => receipts().issueIn(tx, `payment:${payment.id}:succeeded`))));
    expect(await seq()).toBe(before);
    const rows = await t.prisma.receipt.findMany({ where: { paymentId: payment.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountMinor: payment.amountMinor, currency: payment.currency, gstRegisteredAtIssue: false, causeKey: `payment:${payment.id}:succeeded` });
    expect(rows[0]!.number).toMatch(/^MT-T-[1-9]\d*$/);
    expect(rows[0]!.fundsAfterMinor).toBe(payment.amountMinor);
    expect(await receipts().missingKeys({ bookingIds: [bookingId] })).toEqual([]);
  });

  it('receipt_numbers_gapless_under_concurrency_and_rollback', async () => {
    const list = [await paid(false), await paid(false), await paid(false), await paid(false)];
    const before = await seq();
    // A transaction that fails after taking a number takes nothing.
    await expect(t.prisma.$transaction(async (tx) => {
      await receipts().issueIn(tx, `payment:${list[0]!.payment.id}:succeeded`);
      throw new Error('rolled back');
    })).rejects.toThrow('rolled back');
    expect(await seq()).toBe(before);
    expect(await t.prisma.receipt.count({ where: { paymentId: list[0]!.payment.id } })).toBe(0);
    const numbers = await Promise.all(list.map((x) => runTransaction(t.prisma, (tx) => receipts().issueIn(tx, `payment:${x.payment.id}:succeeded`))));
    const values = numbers.map((n) => num(n!)).sort((a, b) => (a < b ? -1 : 1));
    expect(values).toEqual([before, before + 1n, before + 2n, before + 3n]);
    expect(await seq()).toBe(before + 4n);
  });

  it('notes for a gateway refund, a chargeback and its reinstatement reference the receipt, in one numbering', async () => {
    const { bookingId, payment, reference } = await paid();
    const r = sim.gatewayRefund(acc.id, payment.providerPaymentRef!, 500n);
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, r.ref))).outcome).toBe('processed');
    const d = sim.openDispute(acc.id, payment.providerPaymentRef!, { amountMinor: 1000n, withdrawn: true });
    expect((await deliver(t, acc, sim.disputeEvent(acc.secret, acc.id, d.ref))).outcome).toBe('processed');
    sim.moveDispute(acc.id, d.ref, { status: 'won', fundsReinstated: true });
    expect((await deliver(t, acc, sim.disputeEvent(acc.secret, acc.id, d.ref))).outcome).toBe('processed');
    expect(await receipts().sweep({ bookingIds: [bookingId] })).toBe(3);
    const docs = await receipts().listForBooking(bookingId);
    expect(docs.map((x) => [x.kind, x.amountMinor])).toEqual([['receipt', payment.amountMinor.toString()], ['refund', '500'], ['chargeback', '1000'], ['chargeback_reinstatement', '1000']]);
    const receiptNo = docs[0]!.number;
    expect(docs.slice(1).every((x) => x.receiptNumber === receiptNo)).toBe(true);
    const notes = await t.prisma.receiptNote.findMany({ where: { bookingId }, orderBy: { number: 'asc' } });
    expect(notes.map((n) => n.direction).sort()).toEqual(['decrease', 'decrease', 'increase']);
    // No personal data in what is printed (plan 4.6, 4.5): booking reference and trip, never the customer.
    const customer = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { customer: { select: { givenName: true, familyName: true, email: true } } } });
    for (const doc of [...(await t.prisma.receipt.findMany({ where: { bookingId } })), ...notes]) {
      const text = JSON.stringify(doc.content);
      expect(text).toContain(reference);
      for (const pii of [customer.customer.email, customer.customer.familyName].filter((x): x is string => !!x && x.length > 2)) expect(text.includes(pii)).toBe(false);
      expect(/gst|tax invoice/i.test(text)).toBe(false);
      expect(doc.contentSha256).toBe(contentSha256(doc.content as unknown as DocumentContent));
    }
  });

  it('receipts_are_append_only; one void per receipt; a number used once and for its kind', async () => {
    const { bookingId, payment } = await paid();
    const rec = await t.prisma.receipt.findUniqueOrThrow({ where: { paymentId: payment.id } });
    const app = await connect('app');
    const owner = await connect('owner');
    try {
      for (const db of [app, owner]) {
        expect(await txError(db, [[`UPDATE receipts SET "amountMinor" = 1 WHERE id = $1::uuid`, [rec.id]]])).not.toBeNull();
        expect(await txError(db, [[`DELETE FROM receipts WHERE id = $1::uuid`, [rec.id]]])).not.toBeNull();
        expect(await txError(db, [[`UPDATE receipt_numbers SET kind = 'note' WHERE number = $1`, [rec.number]]])).not.toBeNull();
      }
      const note = (n: string) => [`INSERT INTO receipt_notes (id, number, kind, direction, "receiptId", "bookingId", mode, currency, "amountMinor", "causeKey", "fundsAfterMinor", content, "layoutVersion", "contentSha256")
        VALUES (gen_random_uuid(), $1, 'void', 'decrease', $2::uuid, $3::uuid, 'test', $4, $5, $6, 0, '{}'::jsonb, 1, repeat('a', 64))`, [n, rec.id, bookingId, rec.currency, rec.amountMinor, `test:${randomUUID()}`]] as [string, unknown[]];
      const n1 = `MT-T-${9_000_000_000n + BigInt(Math.floor(Math.random() * 1e9))}`;
      const n2 = `MT-T-${9_100_000_000n + BigInt(Math.floor(Math.random() * 1e9))}`;
      // Two voids of one receipt: the second is refused.
      expect(await txError(app, [[`INSERT INTO receipt_numbers (number, mode, kind) VALUES ($1, 'test', 'note'), ($2, 'test', 'note')`, [n1, n2]], note(n1), note(n2)])).toBe('23505');
      // A receipt's number is not a note's; a test number is not live.
      expect(await txError(app, [note(rec.number)])).not.toBeNull();
      expect(await txError(app, [[`INSERT INTO receipt_numbers (number, mode, kind) VALUES ($1, 'live', 'note')`, [n1]]])).toBe('23514');
      // No GST can be recorded as registered (review R7).
      expect(await txError(app, [
        [`INSERT INTO receipt_numbers (number, mode, kind) VALUES ($1, 'test', 'note')`, [n1]],
        [`INSERT INTO receipt_notes (id, number, kind, direction, "receiptId", "bookingId", mode, currency, "amountMinor", "causeKey", "fundsAfterMinor", content, "layoutVersion", "contentSha256", "gstRegisteredAtIssue")
          VALUES (gen_random_uuid(), $1, 'void', 'decrease', $2::uuid, $3::uuid, 'test', $4, $5, $6, 0, '{}'::jsonb, 1, repeat('a', 64), true)`, [n1, rec.id, bookingId, rec.currency, rec.amountMinor, `test:${randomUUID()}`]],
      ])).toBe('23514');
    } finally {
      await app.end();
      await owner.end();
    }
  });
});

describe('who sees receipts (plan 4.6, 4.7 and 6)', () => {
  it('customer_cannot_read_other_bookings_receipts; the owner lists and downloads; receipt_pdf_rebuilds_identically', async () => {
    const { reference, bookingId } = await paid();
    const mine = await t.http().get(`/account/bookings/${reference}/receipts`).set('Cookie', c.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body.documents).toHaveLength(1);
    const number = mine.body.documents[0].number as string;
    const pdf1 = await t.http().get(`/account/bookings/${reference}/receipts/${number}`).set('Cookie', c.cookie).buffer(true);
    const pdf2 = await t.http().get(`/account/bookings/${reference}/receipts/${number}`).set('Cookie', c.cookie).buffer(true);
    expect([pdf1.status, pdf1.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect(Buffer.from(pdf1.body as Buffer).equals(Buffer.from(pdf2.body as Buffer))).toBe(true);
    expect(/GST|tax invoice/i.test(Buffer.from(pdf1.body as Buffer).toString('latin1'))).toBe(false);
    // Another booking of another customer: its number through my booking is the same 404.
    const other = await payingCustomer(t);
    expect((await t.http().get(`/account/bookings/${reference}/receipts`).set('Cookie', other.cookie)).status).toBe(404);
    const theirs = await (async () => {
      const r = await approvedBooking(t, admin, await pricedWorld(admin), other);
      expect((await other.pay(r.reference, { method: 'card' })).status).toBe(201);
      const p = (await t.prisma.payment.findMany({ where: { bookingId: r.bookingId } }))[0]!;
      sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
      await deliver(t, acc, await eventFor(t, acc, p.id));
      await receipts().sweep({ bookingIds: [r.bookingId] });
      return (await t.prisma.receipt.findFirstOrThrow({ where: { bookingId: r.bookingId } })).number;
    })();
    expect((await t.http().get(`/account/bookings/${reference}/receipts/${theirs}`).set('Cookie', c.cookie)).status).toBe(404);
    expect((await t.http().get(`/account/bookings/${reference}/receipts/not-a-number`).set('Cookie', c.cookie)).status).toBe(404);
    // Staff with the permission; without it, 403.
    expect((await admin.get(`/admin/payments/bookings/${bookingId}/receipts`)).body.documents).toHaveLength(1);
    const plain = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS]);
    expect((await plain.get(`/admin/payments/bookings/${bookingId}/receipts`)).status).toBe(403);
    expect((await plain.get(`/admin/payments/receipts/${number}`)).status).toBe(403);
    expect((await admin.get(`/admin/payments/receipts/${number}`)).status).toBe(200);
  });

  it('gst_registration_cannot_be_switched_on through the settings API either', async () => {
    const owner = await staffClient(t, ['platform.setting.read', 'platform.setting.manage', 'platform.setting.manageFinancial']);
    const res = await owner.put('/admin/settings/tax.registration', { value: { gstRegistered: true }, version: 0, reason: 'accountant said so' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await t.prisma.setting.findUnique({ where: { key: 'tax.registration' } }).then((s) => (s?.value as { gstRegistered?: boolean } | undefined)?.gstRegistered ?? false)).toBe(false);
  });
});

describe('customer money report through the API (plan 4.6, 5)', () => {
  it('report_separates_unpaid_supplier_funds_from_margin; test_mode_payment_not_counted_in_production; permission', async () => {
    const w = await pricedWorld(admin);
    const { reference, bookingId } = await approvedBooking(t, admin, w, c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const p = (await t.prisma.payment.findMany({ where: { bookingId } }))[0]!;
    sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, p.id));
    const supplier = await t.prisma.supplier.create({ data: { kind: 'hotel', name: `Hotel ${randomUUID().slice(0, 6)}`, countryCode: 'AU', defaultCurrency: 'AUD' } });
    await t.prisma.costItem.create({ data: { supplierId: supplier.id, packageId: w.pkg.id, description: 'Rooms', basis: 'fixed', quantity: 1, unitAmountMinor: 30_000n, amountMinor: 30_000n, currency: 'AUD', status: 'due' } });
    const res = await admin.get('/admin/payments/reports/client-money');
    expect(res.status).toBe(200);
    const row = (res.body.rows as Array<{ packageId: string; costsNote: string; feesImported: boolean; money: Record<string, string | boolean | null> }>).find((r) => r.packageId === w.pkg.id)!;
    expect(row.costsNote).toBe('ok');
    expect(row.money).toMatchObject({ heldMinor: p.amountMinor.toString(), owedToSuppliersMinor: '30000', marginNotEarnedMinor: (p.amountMinor - 30_000n).toString(), marginEarnedMinor: '0', keepSeparateMinor: p.amountMinor.toString(), tripTravelled: false });
    // The simulator lists its payouts: its fees are imported (a gateway that does not would say so).
    expect(row.feesImported).toBe(true);
    // Only the environment's mode counts: in production (live) this test-mode money is not there.
    const gw = t.app.get((await import('../../../src/modules/payments/core/gateway')).ProviderGateway);
    const spy = vi.spyOn(gw, 'mode', 'get').mockReturnValue('live');
    try {
      const live = await t.app.get((await import('../../../src/modules/payments/core/client-money.service')).ClientMoneyService).report();
      expect(live.rows.find((r) => r.packageId === w.pkg.id)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const plain = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, 'payments.payment.read']);
    expect((await plain.get('/admin/payments/reports/client-money')).status).toBe(403);
  });
});
