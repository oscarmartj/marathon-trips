// The manual PayID transfer method, through HTTP and a real PostgreSQL (plan docs/plans/3.4-manual-payid-transfer.md).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingExpiryService } from '../../../src/modules/bookings/expiry.service';
import { InboundPaymentHooks } from '../../../src/modules/payments/core/inbound-hooks';
import { ManualMethodsService } from '../../../src/modules/payments/core/manual-methods.service';
import { PaymentsMaintenanceService } from '../../../src/modules/payments/core/maintenance.service';
import { PaymentRouting } from '../../../src/modules/payments/core/routing';
import { ProviderGateway, modeForEnv } from '../../../src/modules/payments/core/gateway';
import { ProviderAccountsService } from '../../../src/modules/payments/core/accounts.service';
import { TestApp, makeApp } from '../../support/auth';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { balancesOf, ledgerOf } from '../../support/ledger';
import { CATALOGUE_AND_PRICING, Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents, requestBody } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import { PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, expireNow, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount } from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
let acc: SimAccount;
let manualId: string;
let c: PayingCustomer;
let ref = 0;
const uniq = (p = 'TX') => `${p}-${Date.now().toString(36).toUpperCase()}-${(ref += 1)}`;

const CONFIG = {
  enabled: true, countries: ['AU'], displayOrder: 0, instructions: { 'en-AU': 'Pay with your banking app.' }, payeeName: 'Marathon Trips Pty Ltd',
  payId: { type: 'email', value: 'payments@example.com' }, bank: null,
};

async function setConfig(over: Record<string, unknown> = {}, who: Client = admin, method = 'payid_transfer') {
  const list = await admin.get('/admin/payments/methods');
  const version = (list.body.items as Array<{ method: string; version: number }>).find((m) => m.method === method)!.version;
  return who.put(`/admin/payments/methods/${method}`, { version, ...CONFIG, ...over });
}

beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  manualId = (await t.app.get(ProviderAccountsService).createManualAccount({ displayName: 'Test bank transfer' })).id;
  c = await payingCustomer(t);
  const r = await setConfig();
  if (r.status !== 200) throw new Error(`config failed ${r.status} ${JSON.stringify(r.body)}`);
});
afterAll(async () => {
  // Leave the shared database as other files expect it: no manual account in routing, the method off.
  await t.prisma.providerAccount.update({ where: { id: manualId }, data: { status: 'paused' } });
  await setConfig({ enabled: false });
  await cleanPayments(t);
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'bookings.maintenance' AND data ? 'bookingId'`);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const bookingRow = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
const paymentsOf = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
const inbound = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId, origin: 'inbound' }, orderBy: { attemptNumber: 'asc' } });
const events = (aggregateId: string, type: string) => t.prisma.outboxEvent.count({ where: { aggregateId, type } });

async function booked(autoConfirm = true): Promise<{ reference: string; bookingId: string; depositMinor: bigint; totalMinor: bigint }> {
  const w = await pricedWorld(admin);
  if (!autoConfirm) await t.prisma.$executeRawUnsafe(`UPDATE packages SET "autoConfirmOnDeposit" = false WHERE id = $1::uuid`, w.pkg.id);
  const b = await approvedBooking(t, admin, w, c);
  const row = await bookingRow(b.bookingId);
  return { ...b, depositMinor: row.depositMinor, totalMinor: row.totalMinor };
}

const confirm = (bookingId: string, body: Record<string, unknown>, who: Client = admin) => who.post(`/admin/payments/bookings/${bookingId}/inbound-payments`, body);
const voidIt = (id: string, body: Record<string, unknown>, who: Client = admin) => who.post(`/admin/payments/payments/${id}/void`, body);
const staleStaff = async (perms = [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS]) => {
  const { ALL_PAYMENT_PERMISSIONS } = await import('../../support/payments');
  const s = await staffClient(t, [...perms, ...ALL_PAYMENT_PERMISSIONS]);
  await t.prisma.session.updateMany({ where: { userId: s.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
  return s;
};

describe('the methods and their configuration (section 5)', () => {
  it('edit_manual_instructions_requires_step_up_and_is_audited; stale version; invalid data', async () => {
    const stale = await staleStaff();
    const r = await setConfig({}, stale);
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    const nobody = await staffClient(t, CATALOGUE_AND_PRICING);
    expect((await setConfig({}, nobody)).status).toBe(403);
    const ok = await setConfig({ instructions: { 'en-AU': 'Updated words.' } });
    expect(ok.status).toBe(200);
    const audit = await t.prisma.auditLog.findFirst({ where: { action: 'payments.methodConfig.updated' }, orderBy: { occurredAt: 'desc' } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.changes)).toContain('Pay with your banking app');
    expect(JSON.stringify(audit!.changes)).toContain('Updated words');
    const old = await admin.put('/admin/payments/methods/payid_transfer', { version: ok.body.version - 1, ...CONFIG });
    expect([old.status, old.body.code]).toEqual([409, 'version_conflict']);
  });

  it('enable_with_invalid_payee_is_422: PayID, BSB, account, countries and unknown methods', async () => {
    const bad: Array<Record<string, unknown>> = [
      { payId: { type: 'email', value: 'not-an-email' } }, { payId: { type: 'phone', value: '0400000000' } }, { payId: { type: 'abn', value: '123' } },
      { payId: null, bank: null }, { payId: null, bank: { bsb: '12', accountNumber: '12345678' } }, { payId: null, bank: { bsb: '123-456', accountNumber: 'abc' } },
      { countries: [] }, { payeeName: null }, { instructions: { 'es-ES': 'solo español' } },
    ];
    for (const b of bad) expect((await setConfig(b)).status, JSON.stringify(b)).toBe(422);
    expect((await admin.put('/admin/payments/methods/card', { version: 0, ...CONFIG })).status).toBe(404);
    // BSB and account number are accepted, and shown with the dash.
    expect((await setConfig({ payId: null, bank: { bsb: '123-456', accountNumber: '12345678' } })).status).toBe(200);
    expect((await admin.get('/admin/payments/methods/payid_transfer/test')).body).toEqual({ ok: true });
    expect((await setConfig()).status).toBe(200);
  });

  it('manual_methods_follow_config_enabled_country_and_validity', async () => {
    const { reference } = await booked();
    expect((await c.plan(reference)).body.methods).toContain('payid_transfer');
    expect((await setConfig({ countries: ['NZ'] })).status).toBe(200);
    expect((await c.plan(reference)).body.methods).not.toContain('payid_transfer');
    const refused = await c.pay(reference, { method: 'payid_transfer' });
    expect([refused.status, refused.body.code]).toEqual([409, 'no_payment_method_available']);
    expect((await setConfig({ enabled: false })).status).toBe(200);
    expect((await c.plan(reference)).body.methods).not.toContain('payid_transfer');
    expect((await setConfig()).status).toBe(200);
    expect((await c.plan(reference)).body.methods).toContain('payid_transfer');
  });

  it('manual_account_is_test_only and manual_method_not_offered_in_production_env', async () => {
    const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: manualId } });
    expect([row.adapterKey, row.mode]).toEqual(['manual', 'test']);
    expect(row.credentialsCiphertext).not.toContain('{');
    await expect(t.prisma.$executeRawUnsafe(`UPDATE provider_accounts SET mode = 'live' WHERE id = $1::uuid`, manualId)).rejects.toThrow(/never change/);
    const real = t.app.get(ProviderGateway);
    const prod = Object.create(real, { env: { get: () => 'production' }, mode: { get: () => modeForEnv('production') } }) as ProviderGateway;
    const routing = new PaymentRouting(prod, t.app.get(ManualMethodsService));
    expect(await routing.candidates(t.prisma, { method: 'payid_transfer', currency: 'AUD', country: 'AU' })).toEqual([]);
  });
});

describe('the customer asks to pay by transfer (section 2)', () => {
  it('start_gives_instructions_without_a_gateway: no amount from the customer, no live slot, resumed when repeated', async () => {
    const b = await booked();
    const bad = await c.pay(b.reference, { method: 'payid_transfer', amountMinor: '1' });
    expect(bad.status).toBe(422);
    const r = await c.pay(b.reference, { method: 'payid_transfer' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'created', method: 'payid_transfer', amountMinor: b.depositMinor.toString(), currency: 'AUD' });
    expect(r.body.nextAction).toBeUndefined();
    expect(r.body.manual).toMatchObject({ reference: b.reference, payeeName: 'Marathon Trips Pty Ltd', payId: { type: 'email', value: 'payments@example.com' }, bank: null, note: 'Pay with your banking app.', amountMinor: b.depositMinor.toString() });
    const [p] = await paymentsOf(b.bookingId);
    expect(p).toMatchObject({ origin: 'manual_intent', status: 'created', liveBookingId: null, providerPaymentRef: null, adapterKey: 'manual', providerAccountId: manualId });
    expect(p!.idempotencyKey).toBe(`booking:${b.bookingId}:attempt:1`);
    // Same request: the same attempt, with the same expiry (P3).
    const again = await c.pay(b.reference, { method: 'payid_transfer' });
    expect(again.status).toBe(201);
    expect(await paymentsOf(b.bookingId)).toHaveLength(1);
    const plan = (await c.plan(b.reference)).body;
    expect(plan.manualIntent).toMatchObject({ reference: b.reference, amountMinor: b.depositMinor.toString() });
    expect(plan.liveAttempt).toBeNull();
  });

  it('no_surcharge_for_manual_method: the amount is the same as a card attempt would be', async () => {
    const b = await booked();
    const card = await c.pay(b.reference, { method: 'card' });
    const manualFirst = await booked();
    const m = await c.pay(manualFirst.reference, { method: 'payid_transfer' });
    expect(m.body.amountMinor).toBe(manualFirst.depositMinor.toString());
    expect(card.body.amountMinor).toBe(b.depositMinor.toString());
  });

  it('manual_intent_never_succeeds: not through the database either', async () => {
    const b = await booked();
    await c.pay(b.reference, { method: 'payid_transfer' });
    const [p] = await paymentsOf(b.bookingId);
    for (const [sql, constraint] of [
      [`UPDATE payments SET status = 'succeeded', version = version + 1, "succeededAt" = now(), "providerPaymentRef" = 'x' WHERE id = $1::uuid`, 'payments_manual_intent_check'],
      [`UPDATE payments SET status = 'pending', version = version + 1 WHERE id = $1::uuid`, 'payments_manual_intent_check'],
      [`UPDATE payments SET "liveBookingId" = "bookingId" WHERE id = $1::uuid`, 'payments_live_check'],
    ] as const) await expect(t.prisma.$executeRawUnsafe(sql, p!.id), constraint).rejects.toThrow(new RegExp(`violates check constraint "${constraint}"`));
  });

  it('manual_intent_cancelled_by_new_card_attempt; manual_intent_does_not_block_approval_expiry', async () => {
    const b = await booked();
    await c.pay(b.reference, { method: 'payid_transfer' });
    // An open intent holds nothing: the approval can still expire.
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET "approvalExpiresAt" = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, b.bookingId);
    const card = await booked();
    await c.pay(card.reference, { method: 'payid_transfer' });
    const r = await c.pay(card.reference, { method: 'card' });
    expect(r.status).toBe(201);
    const ps = await paymentsOf(card.bookingId);
    expect(ps.map((p) => [p.origin, p.status])).toEqual([['manual_intent', 'cancelled'], ['collection', 'requires_action']]);
    expect(ps[1]!.liveBookingId).toBe(card.bookingId);
    await t.app.get(BookingExpiryService).run();
    expect((await bookingRow(b.bookingId)).status).toBe('expired');
  });

  it('manual_start_new_amount_replaces and the sweep closes lapsed or unpayable intents', async () => {
    const b = await booked(false);
    await c.pay(b.reference, { method: 'payid_transfer' });
    await c.pay(b.reference, { method: 'payid_transfer', upToSequence: 2 });
    const ps = await paymentsOf(b.bookingId);
    expect(ps.map((p) => [p.status, p.amountMinor === b.totalMinor])).toEqual([['cancelled', false], ['created', true]]);
    // Lapsed.
    await expireNow(ps[1]!.id);
    const run = await t.app.get(PaymentsMaintenanceService).run();
    expect(run.manualIntentsClosed).toContain(ps[1]!.id);
    expect((await paymentsOf(b.bookingId)).at(-1)!.status).toBe('expired');
    // A booking that can no longer be paid.
    const other = await booked();
    await c.pay(other.reference, { method: 'payid_transfer' });
    expect((await admin.post(`/admin/bookings/${other.bookingId}/cancel`, { version: (await bookingRow(other.bookingId)).version, reason: 'test' })).status).toBe(200);
    expect((await t.app.get(PaymentsMaintenanceService).run()).manualIntentsClosed).toContain((await paymentsOf(other.bookingId))[0]!.id);
    expect((await paymentsOf(other.bookingId))[0]!.status).toBe('cancelled');
  });

  it('a live card attempt blocks a transfer request the same way it blocks another card', async () => {
    const b = await booked();
    expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
    const r = await c.pay(b.reference, { method: 'payid_transfer' });
    expect([r.status, r.body.code]).toEqual([409, 'payment_attempt_in_progress']);
  });
});

describe('staff confirm a transfer (section 3)', () => {
  it('confirmation moves the booking, closes the request and is audited', async () => {
    const b = await booked();
    await c.pay(b.reference, { method: 'payid_transfer' });
    const reference = uniq();
    const r = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, transfer: { status: 'succeeded', amountMinor: b.depositMinor.toString(), currency: 'AUD', reference: reference.toUpperCase() } });
    const ps = await paymentsOf(b.bookingId);
    expect(ps.map((p) => [p.origin, p.status])).toEqual([['manual_intent', 'cancelled'], ['inbound', 'succeeded']]);
    expect(ps[1]).toMatchObject({ liveBookingId: null, payerReference: b.reference, adapterKey: 'manual', method: 'payid_transfer', providerAccountId: manualId });
    expect(ps[1]!.idempotencyKey).toBe(`booking:${b.bookingId}:inbound:2`);
    expect(ps[1]!.idempotencyKey).not.toContain(reference);
    // The package auto-confirms on the deposit.
    expect((await bookingRow(b.bookingId)).status).toBe('confirmed');
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.transfer.confirmed', entityId: ps[1]!.id } })).toBe(1);
    expect(await events(ps[1]!.id, 'payments.payment.succeeded')).toBe(1);
  });

  it('manual_confirmation_twice_posts_once: a repeat and two at once', async () => {
    const b = await booked(false);
    const reference = uniq();
    const body = { amountMinor: b.depositMinor.toString(), reference };
    const [one, two] = await Promise.all([confirm(b.bookingId, body), confirm(b.bookingId, body)]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body.transfer.id).toBe(two.body.transfer.id);
    expect([one.body.replayed, two.body.replayed].sort()).toEqual([false, true]);
    const again = await confirm(b.bookingId, { ...body, reference: reference.toLowerCase() });
    expect([again.status, again.body.replayed]).toEqual([200, true]);
    expect(await inbound(b.bookingId)).toHaveLength(1);
    expect(await events(one.body.transfer.id, 'payments.payment.succeeded')).toBe(1);
  });

  it('reference_reused_with_other_amount_or_booking_is_409', async () => {
    const b = await booked(false);
    const other = await booked(false);
    const reference = uniq();
    expect((await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference })).status).toBe(200);
    for (const [id, amount] of [[b.bookingId, (b.depositMinor + 1n).toString()], [other.bookingId, b.depositMinor.toString()]] as const) {
      const r = await confirm(id, { amountMinor: amount, reference });
      expect([r.status, r.body.code]).toEqual([409, 'reference_already_recorded']);
    }
    expect(await inbound(other.bookingId)).toHaveLength(0);
    // The same movement for two bookings at once: exactly one wins.
    const x = await booked(false);
    const y = await booked(false);
    const shared = uniq();
    const rs = await Promise.all([confirm(x.bookingId, { amountMinor: x.depositMinor.toString(), reference: shared }), confirm(y.bookingId, { amountMinor: x.depositMinor.toString(), reference: shared })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('manual_confirmation_without_reference_rejected; inbound_amount_validation_table', async () => {
    const b = await booked(false);
    const amount = b.depositMinor.toString();
    for (const body of [
      {}, { amountMinor: amount }, { amountMinor: amount, reference: '' }, { amountMinor: amount, reference: '   ' }, { amountMinor: amount, reference: 'a;b' }, { amountMinor: amount, reference: 'x'.repeat(101) },
      { amountMinor: amount, reference: 'ok', currency: 'AUD' }, { amountMinor: amount, reference: 'ok', method: 'card' },
      { reference: 'R-1', amountMinor: '0' }, { reference: 'R-2', amountMinor: '-5' }, { reference: 'R-3', amountMinor: '10.5' }, { reference: 'R-4', amountMinor: '012' },
      { reference: 'R-5', amountMinor: 12 }, { reference: 'R-6', amountMinor: '1e3' }, { reference: 'R-7', amountMinor: '1000000000000' },
    ]) expect((await confirm(b.bookingId, body)).status, JSON.stringify(body)).toBe(422);
    // At the limit and over it.
    const limit = await confirm(b.bookingId, { reference: uniq(), amountMinor: '100000001' });
    expect([limit.status, limit.body.code]).toEqual([409, 'amount_out_of_range']);
    expect(await inbound(b.bookingId)).toHaveLength(0);
  });

  it('inbound_confirmation_amount_from_staff_with_step_up; permission; unknown booking; unpayable states', async () => {
    const b = await booked(false);
    const body = { amountMinor: b.depositMinor.toString(), reference: uniq() };
    const stale = await staleStaff();
    expect([(await confirm(b.bookingId, body, stale)).status, (await confirm(b.bookingId, body, stale)).body.code]).toEqual([403, 'step_up_required']);
    const nobody = await staffClient(t, CATALOGUE_AND_PRICING);
    expect((await confirm(b.bookingId, body, nobody)).status).toBe(403);
    expect((await confirm('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', body)).status).toBe(404);
    expect(await inbound(b.bookingId)).toHaveLength(0);
  });

  it('statement_id_is_the_transfers_own_identity: two equal transfers are both recorded, a repeat of one is a replay, a booking reference is refused', async () => {
    const b = await booked(false);
    const half = (b.depositMinor / 2n).toString();
    const first = uniq('STMT');
    const second = uniq('STMT');
    const one = await confirm(b.bookingId, { amountMinor: half, reference: first });
    const two = await confirm(b.bookingId, { amountMinor: half, reference: second });
    expect([one.status, one.body.replayed, two.status, two.body.replayed]).toEqual([200, false, 200, false]);
    expect(await inbound(b.bookingId)).toHaveLength(2);
    // The same statement line again: nothing is recorded twice.
    const again = await confirm(b.bookingId, { amountMinor: half, reference: second });
    expect([again.status, again.body.replayed, again.body.transfer.id]).toEqual([200, true, two.body.transfer.id]);
    expect(await inbound(b.bookingId)).toHaveLength(2);
    expect((await admin.get(`/admin/payments/bookings/${b.bookingId}`)).body.coverage.collectedMinor).toBe((BigInt(half) * 2n).toString());
    // The booking's own reference names the booking, not the bank movement: refused, whatever its case, and so is anything shaped like one.
    for (const reference of [b.reference, b.reference.toLowerCase(), ` ${b.reference} `, 'MT-ZZZZZZ', 'mt-abc123']) {
      const r = await confirm(b.bookingId, { amountMinor: half, reference });
      expect([r.status, r.body.code], reference).toEqual([422, 'validation_failed']);
    }
    expect(await inbound(b.bookingId)).toHaveLength(2);
  });

  it('a_statement_id_is_recorded_once_across_manual_accounts: a second account cannot take it again (service and database)', async () => {
    const x = await booked(false);
    const y = await booked(false);
    const reference = uniq('STMT');
    expect((await confirm(x.bookingId, { amountMinor: x.depositMinor.toString(), reference })).status).toBe(200);
    const other = (await t.app.get(ProviderAccountsService).createManualAccount({ displayName: 'Second bank account' })).id;
    await t.prisma.providerAccount.update({ where: { id: manualId }, data: { status: 'paused' } });
    try {
      const r = await confirm(y.bookingId, { amountMinor: x.depositMinor.toString(), reference });
      expect([r.status, r.body.code]).toEqual([409, 'reference_already_recorded']);
      await expect(t.prisma.$executeRawUnsafe(
        `INSERT INTO payments (id, "bookingId", currency, origin, "attemptNumber", "payerCustomerId", "providerAccountId", mode, "adapterKey", method, "amountMinor", status, "idempotencyKey", "providerPaymentRef", "payerReference", "pendingExpiresAt", "updatedAt")
         SELECT gen_random_uuid(), "bookingId", currency, 'inbound', 98, "payerCustomerId", $2::uuid, mode, "adapterKey", method, 1, 'created', 'booking:' || "bookingId"::text || ':inbound:98', "providerPaymentRef", "payerReference", now(), now() FROM payments WHERE "bookingId" = $1::uuid AND origin = 'inbound'`,
        x.bookingId, other)).rejects.toThrow(/payments_inbound_ref_not_voided/);
    } finally {
      await t.prisma.providerAccount.update({ where: { id: manualId }, data: { status: 'active' } });
      await t.prisma.providerAccount.update({ where: { id: other }, data: { status: 'paused' } });
    }
    expect(await inbound(y.bookingId)).toHaveLength(0);
  });

  it('unpayable_states: requested, declined and refunded take no transfer; cancelled and expired record it with an overpayment task', async () => {
    const w = await pricedWorld(admin);
    const requestedRes = await c.request(requestBody(w));
    expect(requestedRes.status).toBe(201);
    const requested = await t.prisma.booking.findUniqueOrThrow({ where: { reference: requestedRes.body.reference as string } });
    const body = (amountMinor: string) => ({ amountMinor, reference: uniq('STMT') });
    const refused = async (bookingId: string) => {
      const r = await confirm(bookingId, body('1000'));
      expect([r.status, r.body.code]).toEqual([409, 'booking_cannot_receive_payment']);
      expect(await inbound(bookingId)).toHaveLength(0);
    };
    await refused(requested.id);
    expect((await admin.post(`/admin/bookings/${requested.id}/decline`, { version: requested.version, reason: 'Full' })).status).toBe(200);
    expect((await bookingRow(requested.id)).status).toBe('declined');
    await refused(requested.id);
    // Refunded: a cancelled booking whose money has been given back.
    const gone = await booked(false);
    expect((await admin.post(`/admin/bookings/${gone.bookingId}/cancel`, { version: (await bookingRow(gone.bookingId)).version, reason: 'test' })).status).toBe(200);
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'refunded', version = version + 1 WHERE id = $1::uuid`, gone.bookingId);
    await refused(gone.bookingId);
    // Cancelled and expired: the money did arrive, so it is recorded; all of it is an overpayment for staff to give back.
    const cancelled = await booked(false);
    expect((await admin.post(`/admin/bookings/${cancelled.bookingId}/cancel`, { version: (await bookingRow(cancelled.bookingId)).version, reason: 'test' })).status).toBe(200);
    const late = await booked(false);
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET "approvalExpiresAt" = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, late.bookingId);
    await t.app.get(BookingExpiryService).run();
    expect((await bookingRow(late.bookingId)).status).toBe('expired');
    for (const [status, b] of [['cancelled', cancelled], ['expired', late]] as const) {
      const r = await confirm(b.bookingId, body(b.depositMinor.toString()));
      expect([status, r.status, r.body.replayed], status).toEqual([status, 200, false]);
      expect((await bookingRow(b.bookingId)).status).toBe(status);
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${r.body.transfer.id}` } }), status).toBe(1);
      expect((await admin.get(`/admin/payments/bookings/${b.bookingId}`)).body.allocation.overpaidMinor, status).toBe(b.depositMinor.toString());
    }
  });

  it('the_ledger_must_follow_transfers: a ledger without inbound hooks fails here (task 3.3 registers them)', async () => {
    const ledger = await t.prisma.$queryRawUnsafe<Array<{ table_name: string }>>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ledger%'`);
    const hooks = t.app.get(InboundPaymentHooks);
    // No ledger yet (the state of this task): nothing to follow. Once any ledger table exists, 3.3 must register both hooks.
    if (ledger.length === 0) return;
    const why = `ledger tables (${ledger.map((l) => l.table_name).join(', ')}) exist but no hook follows a transfer`;
    expect(hooks.registered().confirmed, why).toBeGreaterThan(0);
    expect(hooks.registered().voided, why).toBeGreaterThan(0);
  });

  it('a_recorded_transfer_keeps_its_identity: the live guard refuses edits to the statement ID, the payer reference, the amount and the origin', async () => {
    const b = await booked(false);
    const r = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference: uniq('STMT') });
    for (const set of [`"payerReference" = 'MT-AAAAAA'`, `"providerPaymentRef" = 'OTHER-1'`, `"amountMinor" = 1`, `origin = 'collection'`, `"bookingId" = gen_random_uuid()`]) {
      await expect(t.prisma.$executeRawUnsafe(`UPDATE payments SET ${set} WHERE id = $1::uuid`, r.body.transfer.id), set).rejects.toThrow();
    }
    const row = await t.prisma.payment.findUniqueOrThrow({ where: { id: r.body.transfer.id } });
    expect([row.payerReference, row.amountMinor, row.origin]).toEqual([b.reference, b.depositMinor, 'inbound']);
  });

  it('no_manual_account: nothing is recorded', async () => {
    const b = await booked(false);
    await t.prisma.providerAccount.update({ where: { id: manualId }, data: { status: 'paused' } });
    try {
      const r = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference: uniq() });
      expect([r.status, r.body.code]).toEqual([409, 'no_manual_account']);
    } finally {
      await t.prisma.providerAccount.update({ where: { id: manualId }, data: { status: 'active' } });
    }
  });

  it('deposit_paid_in_two_parts_by_transfer and deposit_and_balance_transfers_same_payer_reference', async () => {
    const b = await booked(false);
    const half = b.depositMinor / 2n;
    expect((await confirm(b.bookingId, { amountMinor: half.toString(), reference: uniq() })).status).toBe(200);
    expect((await bookingRow(b.bookingId)).status).toBe('approved');
    expect((await confirm(b.bookingId, { amountMinor: (b.depositMinor - half).toString(), reference: uniq() })).status).toBe(200);
    expect((await bookingRow(b.bookingId)).status).toBe('deposit_paid');
    expect((await confirm(b.bookingId, { amountMinor: (b.totalMinor - b.depositMinor).toString(), reference: uniq() })).status).toBe(200);
    const ps = await inbound(b.bookingId);
    expect(ps).toHaveLength(3);
    expect(new Set(ps.map((p) => p.payerReference))).toEqual(new Set([b.reference]));
    expect(new Set(ps.map((p) => p.providerPaymentRef)).size).toBe(3);
    // Oscar confirms, and the total is covered.
    expect((await admin.post(`/admin/bookings/${b.bookingId}/confirm`, { version: (await bookingRow(b.bookingId)).version })).body.status).toBe('balance_paid');
    const view = (await admin.get(`/admin/payments/bookings/${b.bookingId}`)).body;
    expect(view.allocation.byPayment.map((s: { amountMinor: string }) => BigInt(s.amountMinor)).reduce((a: bigint, x: bigint) => a + x, 0n)).toBe(b.totalMinor);
  });

  it('inbound_payment_posts_once (task 3.3): a confirmation repeated with the same statement ID posts one transfer once', async () => {
    const b = await booked(false);
    const reference = uniq();
    const first = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference });
    const again = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await inbound(b.bookingId)).toHaveLength(1);
    expect(await ledgerOf(t, b.bookingId)).toEqual([
      { idempotencyKey: `payment:${first.body.transfer.id}:succeeded`, kind: 'payment', entries: { clearing: b.depositMinor, customer_funds: -b.depositMinor } },
    ]);
    const clearing = await t.prisma.ledgerEntry.findFirstOrThrow({ where: { transaction: { idempotencyKey: `payment:${first.body.transfer.id}:succeeded` }, amountMinor: { gt: 0n } } });
    expect(clearing.accountCode).toBe(`provider_clearing:${manualId}`);
    expect(await t.app.get(PaymentLedgerCheckService).check({ bookingIds: [b.bookingId] })).toEqual([]);
  });

  it('transfer_over_the_total_records_overpayment_task', async () => {
    const b = await booked();
    const r = await confirm(b.bookingId, { amountMinor: (b.totalMinor + 500n).toString(), reference: uniq() });
    expect(r.status).toBe(200);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${r.body.transfer.id}` } })).toBe(1);
    expect((await admin.get(`/admin/payments/bookings/${b.bookingId}`)).body.allocation.overpaidMinor).toBe('500');
  });

  it('coverage_failure_rolls_back_inbound: a hook that fails leaves nothing recorded', async () => {
    const hooks = t.app.get(InboundPaymentHooks);
    let fail = true;
    hooks.onConfirmed('test-fail', async () => {
      if (fail) throw new Error('boom');
    });
    const b = await booked(false);
    try {
      const r = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference: uniq() });
      expect(r.status).toBe(503);
      expect(await inbound(b.bookingId)).toHaveLength(0);
      expect((await bookingRow(b.bookingId)).status).toBe('approved');
      fail = false;
      expect((await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference: uniq() })).status).toBe(200);
    } finally {
      fail = false;
    }
  });
});

describe('voiding a mistaken transfer (section 4)', () => {
  it('mistaken_inbound_voided_reverses_ledger_and_allocation: the booking goes back to approved and the reference can be used again', async () => {
    const b = await booked(false);
    const approvedAt = (await bookingRow(b.bookingId)).approvedAt;
    const reference = uniq();
    const wrong = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference });
    expect((await bookingRow(b.bookingId)).status).toBe('deposit_paid');
    const voided = await voidIt(wrong.body.transfer.id, { version: wrong.body.transfer.version, reason: 'Typed the wrong booking' });
    expect([voided.status, voided.body.status]).toEqual([200, 'voided']);
    const after = await bookingRow(b.bookingId);
    expect(after.status).toBe('approved');
    expect(after.approvedAt).toEqual(approvedAt);
    expect(after.approvalExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await events(b.bookingId, 'bookings.booking.deposit_reopened')).toBe(1);
    expect(await events(wrong.body.transfer.id, 'payments.payment.voided')).toBe(1);
    const row = await t.prisma.payment.findUniqueOrThrow({ where: { id: wrong.body.transfer.id } });
    expect([row.status, row.providerPaymentRef, row.succeededAt === null]).toEqual(['voided', reference.toUpperCase(), false]);
    // The allocation follows: nothing collected.
    const view = (await admin.get(`/admin/payments/bookings/${b.bookingId}`)).body;
    expect(view.coverage).toMatchObject({ collectedMinor: '0', depositCovered: false });
    expect(view.allocation.byPayment).toEqual([]);
    // The ledger follows (task 3.3): the void is a reversal of the transfer's posting, cash line mirrored, nothing left.
    const id = wrong.body.transfer.id as string;
    expect(await ledgerOf(t, b.bookingId)).toEqual([
      { idempotencyKey: `payment:${id}:succeeded`, kind: 'payment', entries: { clearing: b.depositMinor, customer_funds: -b.depositMinor } },
      { idempotencyKey: `inbound:${id}:voided`, kind: 'reversal', entries: { clearing: -b.depositMinor, customer_funds: b.depositMinor } },
    ]);
    const original = await t.prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `payment:${id}:succeeded` } });
    expect((await t.prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `inbound:${id}:voided` } })).reversesTransactionId).toBe(original.id);
    expect(await balancesOf(t, b.bookingId)).toEqual({ fundsMinor: 0n, overpaymentsMinor: 0n, receivableMinor: 0n });
    // voided_inbound_reference_can_be_reconfirmed, with the right amount.
    const right = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference });
    expect([right.status, right.body.replayed]).toEqual([200, false]);
    expect((await bookingRow(b.bookingId)).status).toBe('deposit_paid');
    expect((await ledgerOf(t, b.bookingId)).map((x) => x.idempotencyKey)).toEqual([`payment:${id}:succeeded`, `inbound:${id}:voided`, `payment:${right.body.transfer.id}:succeeded`]);
    expect(await t.app.get(PaymentLedgerCheckService).check({ bookingIds: [b.bookingId] })).toEqual([]);
    // reference_unique_per_account_while_not_voided (the database too).
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO payments (id, "bookingId", currency, origin, "attemptNumber", "payerCustomerId", "providerAccountId", mode, "adapterKey", method, "amountMinor", status, "idempotencyKey", "providerPaymentRef", "payerReference", "pendingExpiresAt", "updatedAt")
       SELECT gen_random_uuid(), "bookingId", currency, 'inbound', 99, "payerCustomerId", "providerAccountId", mode, "adapterKey", method, 1, 'created', 'booking:' || "bookingId"::text || ':inbound:99', "providerPaymentRef", "payerReference", now(), now() FROM payments WHERE id = $1::uuid`,
      right.body.transfer.id)).rejects.toThrow(/payments_provider_ref_not_voided|payments_inbound_ref_not_voided/);
  });

  it('void_twice_is_409; void_rejects_gateway_payment; void_stale_version_409; void_needs_step_up', async () => {
    const b = await booked(false);
    const ok = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference: uniq() });
    const id = ok.body.transfer.id as string;
    const stale = await staleStaff();
    expect([(await voidIt(id, { version: ok.body.transfer.version, reason: 'x' }, stale)).body.code]).toEqual(['step_up_required']);
    expect((await voidIt(id, { version: ok.body.transfer.version + 5, reason: 'x' })).body.code).toBe('version_conflict');
    expect((await voidIt(id, { version: ok.body.transfer.version })).status).toBe(422);
    expect((await voidIt(id, { version: ok.body.transfer.version, reason: '' })).status).toBe(422);
    expect((await voidIt(id, { version: ok.body.transfer.version, reason: 'Mistake' })).status).toBe(200);
    const twice = await voidIt(id, { version: ok.body.transfer.version + 1, reason: 'Mistake' });
    expect([twice.status, twice.body.code]).toEqual([409, 'payment_not_voidable']);
    // A gateway payment is never voided.
    const g = await booked();
    await c.pay(g.reference, { method: 'card' });
    const [p] = await paymentsOf(g.bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, p!.id));
    const r = await voidIt(p!.id, { version: (await t.prisma.payment.findUniqueOrThrow({ where: { id: p!.id } })).version, reason: 'no' });
    expect([r.status, r.body.code]).toEqual([409, 'payment_not_voidable']);
    expect((await voidIt('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', { version: 0, reason: 'x' })).status).toBe(404);
  });

  it('void_would_uncover_confirmed_booking_is_409; a second transfer keeps the deposit covered so the void goes through', async () => {
    const b = await booked(); // auto-confirms on the deposit
    const first = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference: uniq() });
    expect((await bookingRow(b.bookingId)).status).toBe('confirmed');
    const refused = await voidIt(first.body.transfer.id, { version: first.body.transfer.version, reason: 'Mistake' });
    expect([refused.status, refused.body.code]).toEqual([409, 'void_would_uncover_confirmed_booking']);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: first.body.transfer.id } })).status).toBe('succeeded');
    // The balance arrives and is voided: the deposit stays covered, the booking returns from balance paid to confirmed.
    const bal = await confirm(b.bookingId, { amountMinor: (b.totalMinor - b.depositMinor).toString(), reference: uniq() });
    expect((await bookingRow(b.bookingId)).status).toBe('balance_paid');
    expect((await voidIt(bal.body.transfer.id, { version: bal.body.transfer.version, reason: 'Wrong day' })).status).toBe(200);
    expect((await bookingRow(b.bookingId)).status).toBe('confirmed');
  });

  it('voided hooks run in the transaction: a failing hook undoes the void', async () => {
    const hooks = t.app.get(InboundPaymentHooks);
    let fail = false;
    const seen: string[] = [];
    hooks.onVoided('test-void', async (_tx, p) => {
      seen.push(p.id);
      if (fail) throw new Error('boom');
    });
    const b = await booked(false);
    const ok = await confirm(b.bookingId, { amountMinor: b.depositMinor.toString(), reference: uniq() });
    fail = true;
    const r = await voidIt(ok.body.transfer.id, { version: ok.body.transfer.version, reason: 'x' });
    expect(r.status).toBe(503);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: ok.body.transfer.id } })).status).toBe('succeeded');
    expect((await bookingRow(b.bookingId)).status).toBe('deposit_paid');
    fail = false;
    expect((await voidIt(ok.body.transfer.id, { version: ok.body.transfer.version, reason: 'x' })).status).toBe(200);
    expect(seen).toContain(ok.body.transfer.id);
  });
});

describe('the console command', () => {
  it('manual_account_command_creates_test_account_without_secrets_in_output', async () => {
    const { runCli } = await import('../../../src/cli');
    const lines: string[] = [];
    expect(await runCli(['payments:manual-account', '--name', 'CLI bank'], (l: string) => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toMatch(/created \(test mode\)/);
    expect(lines.join('\n')).not.toMatch(/webhook|secret|token/i);
    const made = await t.prisma.providerAccount.findFirstOrThrow({ where: { displayName: 'CLI bank' } });
    await t.prisma.providerAccount.update({ where: { id: made.id }, data: { status: 'paused' } });
  });
});
