// Refunds of bank transfers (plan docs/plans/4.5-refunds-disputes.md, section 4 and 14; plan 0.1, P13 and finding 1):
// Oscar sends the money from the bank and confirms it with the movement's reference. Nothing here reaches a gateway.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRefundsService } from '../../../src/modules/payments/core/app-refunds.service';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { PaymentRefundSyncService } from '../../../src/modules/payments/core/refund-sync.service';
import { ProviderAccountsService } from '../../../src/modules/payments/core/accounts.service';
import { PAYMENT_ENTITIES } from '../../../src/modules/payments/entities';
import { TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { CATALOGUE_AND_PRICING, Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { ledgerOf } from '../../support/ledger';
import { pricedWorld } from '../../support/pricing';
import { ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, approvedBooking, cleanPayments, onlyAccount, payingCustomer, paymentsStaff, simulatorAccount } from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
let acc: SimAccount;
let manualId: string;
let c: PayingCustomer;
let n = 0;
const uniq = (p = 'RF') => `${p}-${Date.now().toString(36).toUpperCase()}-${(n += 1)}`;
const CONFIG = {
  enabled: true, countries: ['AU'], displayOrder: 0, instructions: { 'en-AU': 'Pay with your banking app.' }, payeeName: 'Marathon Trips Pty Ltd',
  payId: { type: 'email', value: 'payments@example.com' }, bank: null,
};
async function setConfig(over: Record<string, unknown> = {}) {
  const list = await admin.get('/admin/payments/methods');
  const version = (list.body.items as Array<{ method: string; version: number }>).find((m) => m.method === 'payid_transfer')!.version;
  return admin.put('/admin/payments/methods/payid_transfer', { version, ...CONFIG, ...over });
}

beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  manualId = (await t.app.get(ProviderAccountsService).createManualAccount({ displayName: 'Refunds bank transfer' })).id;
  c = await payingCustomer(t);
  expect((await setConfig()).status).toBe(200);
});
afterAll(async () => {
  await t.prisma.providerAccount.update({ where: { id: manualId }, data: { status: 'paused' } });
  await setConfig({ enabled: false, confirmCoverageLoss: true });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const refundOf = (id: string) => t.prisma.refund.findUniqueOrThrow({ where: { id } });
const check = (bookingId: string) => t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] });
const stale = async () => {
  const s = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
  await t.prisma.session.updateMany({ where: { userId: s.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
  return s;
};

/** A booking paid by a bank transfer of the whole total plus `extraMinor`: the extra is an overpayment on that transfer. */
async function overpaidByTransfer(extraMinor = 2500n) {
  const { bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  const r = await admin.post(`/admin/payments/bookings/${bookingId}/inbound-payments`, { amountMinor: (b.totalMinor + extraMinor).toString(), reference: uniq('IN') });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId, origin: 'inbound' } });
  return { bookingId, p, extraMinor };
}

const ask = (paymentId: string, version: number, who: Client = admin) =>
  who.post(`/admin/payments/payments/${paymentId}/refunds`, { paymentVersion: version, purpose: 'overpayment_return', reason: 'Sent too much by transfer' }).set('Idempotency-Key', randomUUID());
const DEST = { accountName: 'Ada Lovelace', payId: null, bank: { bsb: '062-000', accountNumber: '12345678' } };

describe('a manual refund from request to confirmation (P13)', () => {
  it('manual_refund_confirmed_once_with_bank_reference: requested, destination set, seen, confirmed once, posted once', async () => {
    const { bookingId, p, extraMinor } = await overpaidByTransfer();
    const r = await ask(p.id, p.version);
    expect([r.status, r.body.status, r.body.manualRefund, r.body.amountMinor, r.body.hasDestination]).toEqual([201, 'requested', true, extraMinor.toString(), false]);
    const id = r.body.id as string;
    // No destination yet: it cannot be confirmed.
    const early = await admin.post(`/admin/payments/refunds/${id}/confirm-manual`, { version: r.body.version, bankReference: uniq('OUT') });
    expect([early.status, early.body.code]).toEqual([409, 'destination_required']);
    // Bad bank details, then good ones; once only.
    expect((await admin.put(`/admin/payments/refunds/${id}/destination`, { ...DEST, version: r.body.version, bank: { bsb: '12', accountNumber: '1' } })).status).toBe(422);
    expect((await admin.put(`/admin/payments/refunds/${id}/destination`, { ...DEST, version: r.body.version, payId: { type: 'email', value: 'ada@example.com' } })).status).toBe(422);
    const set = await admin.put(`/admin/payments/refunds/${id}/destination`, { ...DEST, version: r.body.version });
    expect([set.status, set.body.hasDestination, set.body.destinationHint]).toEqual([200, true, 'BSB 062-••• acct •••678']);
    expect((await admin.put(`/admin/payments/refunds/${id}/destination`, { ...DEST, version: set.body.version })).body.code).toBe('destination_already_set');
    const seen = await admin.get(`/admin/payments/refunds/${id}/destination`);
    expect([seen.status, seen.headers['cache-control'], seen.body.bank, seen.body.amountMinor]).toEqual([200, 'no-store', { bsb: '062000', accountNumber: '12345678' }, extraMinor.toString()]);
    expect(await t.prisma.auditLog.count({ where: { entityId: id, action: 'payments.refund.destination_viewed' } })).toBe(1);
    // Without a reference: 422. With one: succeeded; a second click changes nothing.
    expect((await admin.post(`/admin/payments/refunds/${id}/confirm-manual`, { version: set.body.version })).status).toBe(422);
    expect((await admin.post(`/admin/payments/refunds/${id}/confirm-manual`, { version: set.body.version, bankReference: 'MT-ABC123' })).status).toBe(422);
    const ref = uniq('OUT');
    const ok = await admin.post(`/admin/payments/refunds/${id}/confirm-manual`, { version: set.body.version, bankReference: ref });
    const again = await admin.post(`/admin/payments/refunds/${id}/confirm-manual`, { version: set.body.version, bankReference: ref });
    expect([ok.status, ok.body.status, ok.body.providerRefundRef, again.status, again.body.status]).toEqual([200, 'succeeded', ref, 200, 'succeeded']);
    const row = await refundOf(id);
    expect(row).toMatchObject({ destinationCiphertext: null, destinationKeyVersion: null, destinationHint: 'BSB 062-••• acct •••678', confirmedById: (admin as unknown as { staff: { id: string } }).staff.id });
    expect((await admin.get(`/admin/payments/refunds/${id}/destination`)).body.code).toBe('destination_not_available');
    const posted = (await ledgerOf(t, bookingId)).filter((x) => x.idempotencyKey === `refund:${id}:succeeded`);
    expect(posted).toEqual([{ idempotencyKey: `refund:${id}:succeeded`, kind: 'refund', entries: { clearing: -extraMinor, customer_overpayments: extraMinor } }]);
    expect(await check(bookingId)).toEqual([]);
  });

  it('manual_refund_requires_step_up: setting, seeing, confirming and cancelling the destination', async () => {
    const { p } = await overpaidByTransfer();
    const r = await ask(p.id, p.version);
    const id = r.body.id as string;
    const s = await stale();
    for (const res of [
      await s.put(`/admin/payments/refunds/${id}/destination`, { ...DEST, version: r.body.version }),
      await s.get(`/admin/payments/refunds/${id}/destination`),
      await s.post(`/admin/payments/refunds/${id}/confirm-manual`, { version: r.body.version, bankReference: uniq('OUT') }),
      await s.post(`/admin/payments/refunds/${id}/cancel-manual`, { version: r.body.version }),
      await ask(p.id, p.version + 1, s),
    ]) expect([res.status, res.body.code]).toEqual([403, 'step_up_required']);
    const reader = await staffClient(t, [...CATALOGUE_AND_PRICING, 'payments.payment.read']);
    expect((await reader.get(`/admin/payments/refunds/${id}/destination`)).status).toBe(403);
    expect((await refundOf(id)).status).toBe('requested');
  });

  it('manual_refund_bank_reference_required_and_unique: one bank movement is one refund, whatever the account', async () => {
    const a = await overpaidByTransfer();
    const b = await overpaidByTransfer();
    const ref = uniq('OUT');
    for (const x of [a, b]) {
      const r = await ask(x.p.id, x.p.version);
      const set = await admin.put(`/admin/payments/refunds/${r.body.id}/destination`, { ...DEST, version: r.body.version });
      (x as Record<string, unknown>).refund = set.body;
    }
    const ra = (a as unknown as { refund: { id: string; version: number } }).refund;
    const rb = (b as unknown as { refund: { id: string; version: number } }).refund;
    expect((await admin.post(`/admin/payments/refunds/${ra.id}/confirm-manual`, { version: ra.version, bankReference: ref })).status).toBe(200);
    const dup = await admin.post(`/admin/payments/refunds/${rb.id}/confirm-manual`, { version: rb.version, bankReference: ref.toLowerCase() });
    expect([dup.status, dup.body.code]).toEqual([409, 'bank_reference_already_used']);
    expect((await refundOf(rb.id)).status).toBe('requested');
  });

  it('manual_refund_cancel_frees_cap_and_drops_destination', async () => {
    const { bookingId, p } = await overpaidByTransfer();
    const r = await ask(p.id, p.version);
    const set = await admin.put(`/admin/payments/refunds/${r.body.id}/destination`, { ...DEST, version: r.body.version });
    expect((await ask(p.id, p.version + 1)).body.code).toBe('nothing_to_refund');
    const cancelled = await admin.post(`/admin/payments/refunds/${r.body.id}/cancel-manual`, { version: set.body.version });
    expect([cancelled.status, cancelled.body.status, cancelled.body.failureCode, cancelled.body.hasDestination]).toEqual([200, 'failed', 'cancelled_by_staff', false]);
    expect(await refundOf(r.body.id)).toMatchObject({ destinationCiphertext: null });
    const fresh = await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect((await ask(p.id, fresh.version)).status).toBe(201);
    expect(await check(bookingId)).toEqual([]);
  });

  it('manual_refund_destination_never_returned_or_logged: only the step-up route shows it; the audit holds a marker', async () => {
    const { bookingId, p } = await overpaidByTransfer();
    const r = await ask(p.id, p.version);
    await admin.put(`/admin/payments/refunds/${r.body.id}/destination`, { ...DEST, version: r.body.version });
    const lists = JSON.stringify([(await admin.get(`/admin/payments/bookings/${bookingId}/refunds`)).body, (await admin.get(`/admin/payments/bookings/${bookingId}`)).body]);
    expect(lists).not.toContain('12345678');
    expect(lists).not.toContain('Ada Lovelace');
    const audits = await t.prisma.auditLog.findMany({ where: { entityId: r.body.id } });
    expect(JSON.stringify(audits.map((a) => a.changes))).not.toContain('12345678');
    expect(JSON.stringify(audits.map((a) => a.changes))).toContain('[changed]');
  });

  it('manual_refund_not_requeried: no gateway sweep ever asks about a manual refund', async () => {
    const { p } = await overpaidByTransfer();
    const r = await ask(p.id, p.version);
    const later = new Date(Date.now() + 3 * 86_400_000);
    expect(await t.app.get(PaymentRefundSyncService).due(later, 10_000)).not.toContain(r.body.id);
    expect(await t.app.get(AppRefundsService).retryDue(later, 10_000)).not.toContain(r.body.id);
    // A week later it gets its own task instead.
    expect(await t.app.get(AppRefundsService).flagWaitingManual(new Date(Date.now() + 8 * 86_400_000))).toContain(r.body.id);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:manual_refund_waiting:${r.body.id}` } })).toBe(1);
    // Closed without acting, it does not come back on the next sweep (re-review, L3).
    await t.prisma.task.updateMany({ where: { sourceRef: `payments:manual_refund_waiting:${r.body.id}` }, data: { status: 'done' } });
    expect(await t.app.get(AppRefundsService).flagWaitingManual(new Date(Date.now() + 8 * 86_400_000))).not.toContain(r.body.id);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:manual_refund_waiting:${r.body.id}` } })).toBe(1);
  });

  it('manual_refund_destination_erased_with_customer: the hint goes with the reason', async () => {
    const keep = c;
    c = await payingCustomer(t);
    try {
      const { p } = await overpaidByTransfer();
      const r = await ask(p.id, p.version);
      const set = await admin.put(`/admin/payments/refunds/${r.body.id}/destination`, { ...DEST, version: r.body.version });
      await admin.post(`/admin/payments/refunds/${r.body.id}/confirm-manual`, { version: set.body.version, bankReference: uniq('OUT') });
      const customerId = (await t.prisma.booking.findUniqueOrThrow({ where: { id: p.bookingId } })).customerId;
      const handler = PAYMENT_ENTITIES.find((e) => e.entityType === 'Refund')!.handlers!.anonymise;
      await t.prisma.$transaction((tx) => handler(tx, customerId, {} as never));
      expect(await refundOf(r.body.id)).toMatchObject({ reason: null, destinationHint: null, destinationCiphertext: null, status: 'succeeded' });
    } finally {
      c = keep;
    }
  });
});

describe('void_inbound_with_refund_rejected (plan 0.1, 6.2; plan review, 1)', () => {
  it('a transfer with a refund requested or made cannot be voided; one whose refund failed can', async () => {
    const { p } = await overpaidByTransfer();
    const r = await ask(p.id, p.version);
    const v1 = await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    const refused = await admin.post(`/admin/payments/payments/${p.id}/void`, { version: v1.version, reason: 'Wrong booking' });
    expect([refused.status, refused.body.code]).toEqual([409, 'void_inbound_with_refund_rejected']);
    await admin.post(`/admin/payments/refunds/${r.body.id}/cancel-manual`, { version: r.body.version });
    const v2 = await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    const voided = await admin.post(`/admin/payments/payments/${p.id}/void`, { version: v2.version, reason: 'Wrong booking' });
    expect(voided.body.code).not.toBe('void_inbound_with_refund_rejected');
  });
});
