// Task 6.2: recording and voiding supplier payments (plan docs/plans/6.2-supplier-payments.md, sections 2, 4, 5, 8, 10
// and 15). The failure paths come first. Recording sends no money: it records a payment already made from the bank.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SupplierLedger } from '../../../src/modules/payments';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { LedgerKeyConflictError } from '../../../src/modules/payments/core/ledger.service';
import { SUPPLIERS_PERMISSIONS, suppliersManifest } from '../../../src/modules/suppliers/manifest';
import { PaymentScheduleService } from '../../../src/modules/suppliers/payment-schedule.service';
import { supplierPaymentKey } from '../../../src/modules/suppliers/supplier-payment.service';
import { TRANSACTION_RETRIES } from '../../../src/platform/database/transaction';
import { ConsumerRegistry } from '../../../src/platform/events/consumers';
import { WEBHOOK_EVENT_CATALOGUE } from '../../../src/platform/integrations/webhook-catalogue';
import { TestApp, makeApp } from '../../support/auth';
import { Client, closeCatalogue } from '../../support/catalogue';
import { connect, txError } from '../../support/ledger';
import { ALL, SP, adminWith, buildWorld, must, setSuppliersFlag, supplierBody } from '../../support/suppliers';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

type Staff = Awaited<ReturnType<typeof adminWith>>;
let t: TestApp;
let admin: Staff;
let other: Staff;
let packageId: string;
beforeAll(async () => {
  t = await makeApp();
  await setSuppliersFlag(t, true);
  admin = await adminWith(t, ALL);
  other = await adminWith(t, ALL);
  packageId = (await buildWorld(admin)).pkg.id;
});
afterAll(async () => {
  await setSuppliersFlag(t, true);
  await closeCatalogue(t);
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
const daysFrom = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const key = () => `k-${randomUUID()}`;

async function newSupplier(client: Client = admin, currency = 'DKK') {
  return must(await client.post('/admin/suppliers', supplierBody({ name: `Hotel ${randomUUID().slice(0, 6)}`, defaultCurrency: currency })), 'supplier').body as { id: string };
}
async function newCost(supplierId: string, over: Record<string, unknown> = {}) {
  return must(await admin.post(`/admin/suppliers/${supplierId}/costs`, { description: 'Hotel block, 8 rooms', basis: 'per_room', quantity: 8, unitAmountMinor: '95050', currency: 'DKK', packageId, ...over }), 'cost').body as { id: string; version: number; amountMinor: string; currency: string };
}
const body = (costs: Array<{ id: string; version: number }>, over: Record<string, unknown> = {}) => ({ items: costs.map((c) => ({ costItemId: c.id, version: c.version })), paidOn: today(), reference: 'INV-2027-0042', ...over });
const pay = (supplierId: string, b: object, k: string = key(), client: Client = admin) => client.post(`/admin/suppliers/${supplierId}/payments`, b).set('Idempotency-Key', k);
const voidIt = (id: string, b: object, k: string = key(), client: Client = admin) => client.post(`/admin/suppliers/payments/${id}/void`, b).set('Idempotency-Key', k);
const costStatus = async (id: string) => (await t.prisma.costItem.findUniqueOrThrow({ where: { id } })).status;
const full = async (id: string) => must(await admin.get(`/admin/suppliers/payments/${id}`), 'get').body;

/** Holds a row lock on cost items from its own connection, so concurrent requests queue behind it for certain. */
async function gate(costIds: string[]) {
  const db = await connect('app');
  const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await db.query('BEGIN');
  await db.query('SELECT id FROM cost_items WHERE id = ANY($1::uuid[]) FOR UPDATE', [costIds]);
  return { pid, release: async () => { await db.query('COMMIT'); await db.end(); } };
}
/** Waits until `n` sessions are queued behind the gate (directly, or behind one already queued on the same row). */
async function waitForLockWaiters(g: { pid: number }, n: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const rows = await t.prisma.$queryRaw<Array<{ pid: number; blockers: number[] }>>`
      SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    const queued = new Set<number>([g.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) if (!queued.has(r.pid) && r.blockers.some((b) => queued.has(b))) { queued.add(r.pid); grew = true; }
    }
    if (queued.size - 1 >= n) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`fewer than ${n} sessions queued behind the gate`);
}

const ledgerOf = (supplierPaymentId: string) => t.prisma.ledgerTransaction.findMany({ where: { supplierPaymentId }, orderBy: { occurredAt: 'asc' }, include: { entries: { orderBy: [{ accountCode: 'asc' }, { currency: 'asc' }] } } });

describe('failure paths of recording (section 10)', () => {
  it('supplier_payment_amount_never_from_request: an amount, a currency or any unknown field is a 422 and writes nothing', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    for (const extra of [{ amountMinor: '1' }, { currency: 'DKK' }, { mode: 'live' }, { status: 'voided' }]) {
      const r = await pay(s.id, body([c], extra));
      expect(r.status).toBe(422);
    }
    expect(await t.prisma.supplierPayment.count({ where: { supplierId: s.id } })).toBe(0);
    expect(await costStatus(c.id)).toBe('planned');
  });

  it('the failure table: each case answers its code and writes nothing', async () => {
    const s = await newSupplier();
    const s2 = await newSupplier();
    const ok = await newCost(s.id);
    const eur = await newCost(s.id, { currency: 'EUR', quantity: 1, unitAmountMinor: '1000' });
    const foreign = await newCost(s2.id);
    const gone = await newCost(s.id, { quantity: 1 });
    must(await admin.post(`/admin/suppliers/costs/${gone.id}/status`, { status: 'cancelled', version: gone.version }), 'cancel');
    const paid = await newCost(s.id, { quantity: 1, unitAmountMinor: '500' });
    must(await pay(s.id, body([paid])), 'pay');
    const cases: Array<[string, () => ReturnType<typeof pay>, number, string]> = [
      ['other supplier', () => pay(s.id, body([ok, foreign])), 422, 'cost_item_supplier_mismatch'],
      ['mixed currencies', () => pay(s.id, body([ok, eur])), 422, 'cost_items_currency_mismatch'],
      ['called off', () => pay(s.id, body([{ id: gone.id, version: gone.version + 1 }])), 409, 'cost_item_not_payable'],
      ['already paid', () => pay(s.id, body([{ id: paid.id, version: paid.version }])), 409, 'cost_item_already_paid'],
      ['stale version', () => pay(s.id, body([{ id: ok.id, version: ok.version + 7 }])), 409, 'version_conflict'],
      ['unknown cost', () => pay(s.id, body([{ id: randomUUID(), version: 0 }])), 404, 'cost_item_not_found'],
      ['unknown supplier', () => pay(randomUUID(), body([ok])), 404, 'supplier_not_found'],
      ['date tomorrow', () => pay(s.id, body([ok], { paidOn: daysFrom(today(), 1) })), 422, 'paid_on_in_future'],
      ['date too old', () => pay(s.id, body([ok], { paidOn: daysFrom(today(), -367) })), 422, 'paid_on_too_old'],
      ['bank amount in the same currency', () => pay(s.id, body([ok], { base: { amountMinor: '100', currency: 'DKK' } })), 422, 'base_currency_same_as_payment'],
      ['bank amount 0', () => pay(s.id, body([ok], { base: { amountMinor: '0', currency: 'AUD' } })), 422, ''],
      ['bank amount not digits', () => pay(s.id, body([ok], { base: { amountMinor: '12.50', currency: 'AUD' } })), 422, ''],
      ['bank amount above the cap', () => pay(s.id, body([ok], { base: { amountMinor: '1000000000001', currency: 'AUD' } })), 422, ''],
      ['bank currency unknown', () => pay(s.id, body([ok], { base: { amountMinor: '100', currency: 'ZZZ' } })), 422, ''],
      ['the same cost twice', () => pay(s.id, { ...body([ok]), items: [{ costItemId: ok.id, version: ok.version }, { costItemId: ok.id, version: ok.version }] }), 422, ''],
      ['no items', () => pay(s.id, { ...body([ok]), items: [] }), 422, ''],
      ['no reference', () => pay(s.id, body([ok], { reference: '  ' })), 422, ''],
      ['no Idempotency-Key', () => admin.post(`/admin/suppliers/${s.id}/payments`, body([ok])), 422, 'idempotency_key_required'],
    ];
    const before = await t.prisma.supplierPayment.count({ where: { supplierId: s.id } });
    for (const [name, run, status, code] of cases) {
      const r = await run();
      expect([name, r.status], JSON.stringify(r.body)).toEqual([name, status]);
      if (code) expect([name, r.body.code]).toEqual([name, code]);
    }
    expect(await t.prisma.supplierPayment.count({ where: { supplierId: s.id } })).toBe(before);
    expect(await costStatus(ok.id)).toBe('planned');
    // A paid cost cannot be cancelled by hand either (6.1's rule, unchanged).
    expect((await admin.post(`/admin/suppliers/costs/${paid.id}/status`, { status: 'cancelled', version: paid.version + 1 })).body.code).toBe('transition_not_allowed');
  });

  it('cost_item_zero_amount: a cost of 0 is never paid, never in the schedule, never an alert (code review, M1)', async () => {
    const s = await newSupplier();
    const zero = await newCost(s.id, { basis: 'fixed', quantity: 1, unitAmountMinor: '0', dueDate: daysFrom(today(), -3) });
    const ok = await newCost(s.id, { dueDate: daysFrom(today(), -3) });
    for (const items of [[zero], [zero, ok]]) {
      const r = await pay(s.id, body(items));
      expect([r.status, r.body.code]).toEqual([422, 'cost_item_zero_amount']);
      const prev = await admin.post(`/admin/suppliers/${s.id}/payments/preview`, { items: items.map((c) => ({ costItemId: c.id, version: c.version })) });
      expect([prev.status, prev.body.code]).toEqual([422, 'cost_item_zero_amount']);
    }
    expect(await costStatus(zero.id)).toBe('planned');
    const sched = must(await admin.get(`/admin/suppliers/payments/schedule?supplierId=${s.id}`), 'schedule').body;
    expect(sched.items.map((i: { costItemId: string }) => i.costItemId)).toEqual([ok.id]);
    await t.app.get(PaymentScheduleService).sweep();
    expect(await t.prisma.task.count({ where: { entityId: zero.id } })).toBe(0);
    expect(await t.prisma.task.count({ where: { entityId: ok.id, status: 'open' } })).toBe(1);
  });

  it('paid_on_brisbane_boundary through the API: at 13:59:59.999Z tomorrow\'s Brisbane date is refused, at 14:00Z it is today', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    // Today's UTC date, so the faked clock stays within hours of the real one (sessions and step-up keep working).
    const utcDay = new Date().toISOString().slice(0, 10);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(`${utcDay}T13:59:59.999Z`));
      const before = await pay(s.id, body([c], { paidOn: daysFrom(utcDay, 1) }));
      expect([before.status, before.body.code]).toEqual([422, 'paid_on_in_future']);
      vi.setSystemTime(new Date(`${utcDay}T14:00:00.000Z`));
      const after = await pay(s.id, body([c], { paidOn: daysFrom(utcDay, 1) }));
      expect(after.status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cost_item_cannot_be_paid_twice: concurrently by two people, one wins and the other gets 409', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    // Deterministic: both requests are queued on the cost's row lock before either can go on.
    const g = await gate([c.id]);
    const pending = Promise.all([pay(s.id, body([c])), pay(s.id, body([c]), key(), other)]);
    await waitForLockWaiters(g, 2);
    await g.release();
    const [a, b] = await pending;
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toBe('cost_item_already_paid');
    expect(await t.prisma.supplierPaymentItem.count({ where: { costItemId: c.id } })).toBe(1);
  });

  it('opposite_order_supplier_payments_do_not_deadlock: [A, B] and [B, A] at once lock in id order', async () => {
    const s = await newSupplier();
    const a = await newCost(s.id);
    const b = await newCost(s.id);
    const deadlocks = TRANSACTION_RETRIES.deadlock;
    // The gate holds only the lower id. Locking in ascending order, both requests queue there; a request that locked in
    // its own order would take the higher id first, and the two would then deadlock once the gate lets go.
    const g = await gate([[a.id, b.id].sort()[0]!]);
    const pending = Promise.all([pay(s.id, body([a, b])), pay(s.id, body([b, a]), key(), other)]);
    await waitForLockWaiters(g, 2);
    await g.release();
    const res = await pending;
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(TRANSACTION_RETRIES.deadlock).toBe(deadlocks);
  });

  it('ledger_failure_rolls_back_supplier_payment: a posting that fails leaves nothing behind', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    const ledger = t.app.get(SupplierLedger);
    const spy = vi.spyOn(ledger, 'postRecorded').mockRejectedValueOnce(new LedgerKeyConflictError());
    try {
      expect((await pay(s.id, body([c]))).status).toBeGreaterThanOrEqual(409);
    } finally {
      spy.mockRestore();
    }
    expect(await t.prisma.supplierPayment.count({ where: { supplierId: s.id } })).toBe(0);
    expect(await costStatus(c.id)).toBe('planned');
    // The same request again (the record was removed on failure) now goes through.
    expect((await pay(s.id, body([c]))).status).toBe(201);
  });
});

describe('access (section 8)', () => {
  it('supplier_payment_requires_step_up and its own permissions; neither is open to API keys', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    const reader = await adminWith(t, [SP.costRead, SP.supplierRead]);
    const none = await adminWith(t, []);
    expect((await none.get('/admin/suppliers/payments/schedule')).status).toBe(403);
    expect((await reader.get(`/admin/suppliers/${s.id}/payments`)).status).toBe(200);
    expect((await reader.get('/admin/suppliers/payments/schedule')).status).toBe(200);
    expect((await pay(s.id, body([c]), key(), reader)).status).toBe(403);
    // The preview writes nothing: seeing costs is enough.
    expect((await reader.post(`/admin/suppliers/${s.id}/payments/preview`, { items: [{ costItemId: c.id, version: c.version }] })).status).toBe(200);
    expect((await none.post(`/admin/suppliers/${s.id}/payments/preview`, { items: [{ costItemId: c.id, version: c.version }] })).status).toBe(403);
    // A session whose second factor is older than the step-up window cannot record or void, but can preview.
    const stale = await adminWith(t, ALL);
    await t.prisma.session.updateMany({ where: { userId: stale.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const r = await pay(s.id, body([c]), key(), stale);
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    expect((await stale.post(`/admin/suppliers/${s.id}/payments/preview`, { items: [{ costItemId: c.id, version: c.version }] })).status).toBe(200);
    const p = must(await pay(s.id, body([c])), 'pay').body;
    const v = await voidIt(p.id, { version: p.version, reason: 'Recorded twice' }, key(), stale);
    expect([v.status, v.body.code]).toEqual([403, 'step_up_required']);
    // Someone who may record but not see costs learns nothing about amounts from the answer (code review, m5).
    const recorder = await adminWith(t, [SP.paymentRecord, SP.paymentVoid]);
    const d = await newCost(s.id, { description: 'Secret cost line' });
    const rec = await pay(s.id, body([d]), key(), recorder);
    expect(rec.status).toBe(201);
    expect(JSON.stringify(rec.body)).not.toMatch(/amountMinor|Secret cost line|INV-2027/);
    expect((await recorder.get(`/admin/suppliers/payments/${rec.body.id}`)).status).toBe(403);
    const vo = await voidIt(rec.body.id, { version: rec.body.version, reason: 'Mistake' }, key(), recorder);
    expect(vo.status).toBe(200);
    expect(JSON.stringify(vo.body)).not.toMatch(/amountMinor|Secret cost line|Mistake/);
    for (const k of [SUPPLIERS_PERMISSIONS.paymentRecord, SUPPLIERS_PERMISSIONS.paymentVoid]) {
      const d = suppliersManifest.permissions.find((x) => x.key === k)!;
      expect([d.requiresStepUp, d.apiKeyScopable]).toEqual([true, false]);
    }
  });

  it('module flag off: payment routes answer 404', async () => {
    await setSuppliersFlag(t, false);
    try {
      expect((await admin.get('/admin/suppliers/payments/schedule')).status).toBe(404);
      expect((await pay(randomUUID(), {})).status).toBe(404);
    } finally {
      await setSuppliersFlag(t, true);
    }
  });
});

describe('recording (sections 4.2, 5)', () => {
  it('records: amount from the server, costs paid, ledger posted without a booking, no free text in audit or event', async () => {
    const s = await newSupplier();
    const a = await newCost(s.id, { description: 'Rooms for Traveller Secretname' });
    const b = await newCost(s.id, { basis: 'fixed', quantity: 1, unitAmountMinor: '1000' });
    const preview = must(await admin.post(`/admin/suppliers/${s.id}/payments/preview`, { items: [{ costItemId: a.id, version: a.version }, { costItemId: b.id, version: b.version }] }), 'preview').body;
    expect(preview).toMatchObject({ amountMinor: '761400', currency: 'DKK' });
    expect(await t.prisma.supplierPayment.count({ where: { supplierId: s.id } })).toBe(0);
    const r = await pay(s.id, body([a, b], { reference: 'BANKREF-XYZZY' }));
    expect(r.status).toBe(201);
    // The answer to recording carries no amounts, descriptions or reference (code review, m5); reading it needs cost.read.
    expect(r.body).toEqual({ id: r.body.id, supplierId: s.id, mode: 'test', status: 'recorded', version: 0, paidOn: today(), items: 2 });
    expect(await full(r.body.id)).toMatchObject({ amountMinor: '761400', currency: 'DKK', status: 'recorded', mode: 'test', base: null, reference: 'BANKREF-XYZZY', paidOn: today() });
    expect(await costStatus(a.id)).toBe('paid');
    expect(await costStatus(b.id)).toBe('paid');
    const [tx] = await ledgerOf(r.body.id);
    expect(tx).toMatchObject({ idempotencyKey: `supplier_payment:${r.body.id}`, kind: 'supplier_payment', bookingId: null, mode: 'test' });
    expect(tx!.entries.map((e) => [e.accountCode, e.currency, e.amountMinor, e.bookingId])).toEqual([['bank', 'DKK', -761_400n, null], ['supplier_payable', 'DKK', 761_400n, null]]);
    // supplier_payment_audit_and_events_carry_no_free_text
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'SupplierPayment', entityId: r.body.id } });
    expect(JSON.stringify(log.changes)).not.toMatch(/BANKREF|Secretname/);
    const ev = await t.prisma.outboxEvent.findFirstOrThrow({ where: { type: 'suppliers.payment.recorded', aggregateId: r.body.id } });
    expect(JSON.stringify(ev.payload)).not.toMatch(/BANKREF|Secretname|761400/);
    expect(ev.payload).toMatchObject({ supplierPaymentId: r.body.id, supplierId: s.id, mode: 'test' });
    // The list shows it.
    const list = must(await admin.get(`/admin/suppliers/${s.id}/payments`), 'list').body;
    expect(list.items.map((p: { id: string }) => p.id)).toEqual([r.body.id]);
  });

  it('fx_conversion_lines_keep_each_currency_exponent: a bank amount in another currency posts as typed, with no rate', async () => {
    const table: Array<{ cost: Record<string, unknown>; base: { amountMinor: string; currency: string }; amount: bigint }> = [
      { cost: { currency: 'EUR', basis: 'fixed', quantity: 1, unitAmountMinor: '120000' }, base: { amountMinor: '201234', currency: 'AUD' }, amount: 120_000n },
      // JPY has no minor unit (exponent 0): 150 000 yen stays 150000.
      { cost: { currency: 'JPY', basis: 'fixed', quantity: 1, unitAmountMinor: '150000' }, base: { amountMinor: '140055', currency: 'AUD' }, amount: 150_000n },
    ];
    for (const row of table) {
      const s = await newSupplier(admin, row.cost.currency as string);
      const c = await newCost(s.id, row.cost);
      const r = must(await pay(s.id, body([c], { base: row.base })), 'pay');
      expect((await full(r.body.id)).base).toEqual(row.base);
      const [tx] = await ledgerOf(r.body.id);
      const cur = row.cost.currency as string;
      const base = BigInt(row.base.amountMinor);
      expect(tx!.entries.map((e) => [e.accountCode, e.currency, e.amountMinor]).sort()).toEqual([
        ['bank', 'AUD', -base], ['fx_conversion', 'AUD', base], ['fx_conversion', cur, -row.amount], ['supplier_payable', cur, row.amount],
      ].sort());
      expect(await t.prisma.supplierPayment.findUniqueOrThrow({ where: { id: r.body.id } })).not.toHaveProperty('fxRateE9');
    }
  });

  it('recording_supplier_payment_sends_nothing: no email, no gateway call, no outbound webhook, no automation', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    const emails = await t.prisma.outboundEmail.count();
    const deliveries = await t.prisma.webhookDelivery.count();
    const gw = t.app.get(ProviderGateway);
    const call = vi.spyOn(gw, 'call');
    try {
      const p = must(await pay(s.id, body([c])), 'pay').body;
      must(await voidIt(p.id, { version: p.version, reason: 'Mistake' }), 'void');
      expect(call).not.toHaveBeenCalled();
    } finally {
      call.mockRestore();
    }
    expect(await t.prisma.outboundEmail.count()).toBe(emails);
    expect(await t.prisma.webhookDelivery.count()).toBe(deliveries);
    // Not in the outbound webhook catalogue, and no automation (or any other consumer) listens to these events.
    expect(WEBHOOK_EVENT_CATALOGUE.map((e) => e.type).filter((x) => x.startsWith('suppliers.payment'))).toEqual([]);
    const registry = t.app.get(ConsumerRegistry);
    for (const type of ['suppliers.payment.recorded', 'suppliers.payment.voided']) expect(registry.forEvent(type).map((d) => d.name)).toEqual([]);
  });
});

describe('idempotency (section 4.3 and plan review, point 1)', () => {
  it('same key and body: one payment; other body: 422; same_client_key_different_staff_isolated', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    const d = await newCost(s.id);
    const k = key();
    const first = must(await pay(s.id, body([c]), k), 'first');
    const again = await pay(s.id, body([c]), k);
    expect([again.status, again.body.id]).toEqual([201, first.body.id]);
    expect((await pay(s.id, body([c], { reference: 'OTHER' }), k)).body.code).toBe('idempotency_key_reused');
    // Another person with the same client key is a different request.
    const theirs = await pay(s.id, body([d]), k, other);
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(first.body.id);
    expect(supplierPaymentKey(admin.staff.id, k)).not.toBe(supplierPaymentKey(other.staff.id, k));
    expect((await t.prisma.supplierPayment.findUniqueOrThrow({ where: { id: first.body.id } })).idempotencyKey).toBe(supplierPaymentKey(admin.staff.id, k));
    expect(await t.prisma.ledgerTransaction.count({ where: { supplierPaymentId: first.body.id } })).toBe(1);
  });

  it('supplier_payment_retry_after_lost_completion_returns_original (the HTTP record lost; the business key answers)', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    const k = key();
    const first = must(await pay(s.id, body([c]), k), 'first');
    await t.prisma.idempotencyRecord.deleteMany({ where: { key: k } });
    const retry = await pay(s.id, body([c]), k);
    expect([retry.status, retry.body.id]).toEqual([200, first.body.id]);
    expect(await t.prisma.supplierPayment.count({ where: { supplierId: s.id } })).toBe(1);
    expect(await t.prisma.ledgerTransaction.count({ where: { supplierPaymentId: first.body.id } })).toBe(1);
    // Other content under the same key, after the record is gone, is still refused.
    await t.prisma.idempotencyRecord.deleteMany({ where: { key: k } });
    expect((await pay(s.id, body([c], { reference: 'DIFFERENT' }), k)).body.code).toBe('idempotency_key_reused');
  });
});

describe('voiding (section 4.4)', () => {
  it('voided_supplier_payment_frees_cost_item: cost due again, item inactive, reversal mirrors, paid again with a new key', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    const p = must(await pay(s.id, body([c], { base: { amountMinor: '150000', currency: 'AUD' } })), 'pay').body;
    expect((await voidIt(p.id, { version: p.version })).status).toBe(422);
    expect((await voidIt(p.id, { version: p.version + 1, reason: 'Wrong supplier' })).body.code).toBe('version_conflict');
    const answer = must(await voidIt(p.id, { version: p.version, reason: 'Recorded against the wrong invoice' }), 'void').body;
    expect(answer).toMatchObject({ status: 'voided', version: p.version + 1 });
    expect(JSON.stringify(answer)).not.toMatch(/wrong invoice|amountMinor/);
    const v = await full(p.id);
    expect(v).toMatchObject({ status: 'voided', voidReason: 'Recorded against the wrong invoice', version: p.version + 1 });
    expect(v.items.every((i: { active: boolean }) => !i.active)).toBe(true);
    expect(await costStatus(c.id)).toBe('due');
    const txs = await ledgerOf(p.id);
    expect(txs.map((x) => [x.kind, x.idempotencyKey])).toEqual([['supplier_payment', `supplier_payment:${p.id}`], ['reversal', `supplier_payment:${p.id}:voided`]]);
    expect(txs[1]!.reversesTransactionId).toBe(txs[0]!.id);
    const sum = new Map<string, bigint>();
    for (const e of txs.flatMap((x) => x.entries)) sum.set(`${e.accountCode}|${e.currency}`, (sum.get(`${e.accountCode}|${e.currency}`) ?? 0n) + e.amountMinor);
    expect([...sum.values()].every((x) => x === 0n)).toBe(true);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'SupplierPayment', entityId: p.id, action: 'suppliers.payment.voided' } });
    expect(JSON.stringify(log.changes)).not.toContain('wrong invoice');
    const fresh = await t.prisma.costItem.findUniqueOrThrow({ where: { id: c.id } });
    const again = must(await pay(s.id, body([{ id: c.id, version: fresh.version }])), 'again').body;
    expect(again.id).not.toBe(p.id);
    expect(await costStatus(c.id)).toBe('paid');
  });

  it('void twice or at once: one void and one reversal; supplier_void_retry_after_lost_completion_returns_payment', async () => {
    const s = await newSupplier();
    const c = await newCost(s.id);
    const p = must(await pay(s.id, body([c])), 'pay').body;
    const [a, b] = await Promise.all([voidIt(p.id, { version: p.version, reason: 'Duplicate' }), voidIt(p.id, { version: p.version, reason: 'Duplicate too' }, key(), other)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toMatch(/supplier_payment_already_voided|version_conflict/);
    const winner = [a, b].find((r) => r.status === 200)!;
    expect(await t.prisma.ledgerTransaction.count({ where: { supplierPaymentId: p.id, kind: 'reversal' } })).toBe(1);
    // The winner retries after losing its HTTP record: same person and reason, so the payment comes back.
    const k = key();
    const me = winner === a ? admin : other;
    const reason = winner === a ? 'Duplicate' : 'Duplicate too';
    const retry = await voidIt(p.id, { version: p.version, reason }, k, me);
    expect([retry.status, retry.body.status]).toEqual([200, 'voided']);
    expect((await voidIt(p.id, { version: p.version + 1, reason: 'Again' })).body.code).toBe('supplier_payment_already_voided');
    expect(await t.prisma.ledgerTransaction.count({ where: { supplierPaymentId: p.id, kind: 'reversal' } })).toBe(1);
  });
});

describe('database guards (section 2.3)', () => {
  let app: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    app = await connect('app');
  });
  afterAll(async () => {
    await app.end();
  });

  async function recorded() {
    const s = await newSupplier();
    const c = await newCost(s.id);
    const p = must(await pay(s.id, body([c])), 'pay').body;
    return { s, c, p };
  }

  it('supplier_payments_append_only: no edit, no delete, no truncate, void fields written once, items fixed', async () => {
    const { s, c, p } = await recorded();
    const cases: Array<[string, string, unknown[]]> = [
      ['amount', `UPDATE supplier_payments SET "amountMinor" = "amountMinor" + 1 WHERE id = $1`, [p.id]],
      ['reference', `UPDATE supplier_payments SET reference = 'x' WHERE id = $1`, [p.id]],
      ['mode', `UPDATE supplier_payments SET mode = 'live' WHERE id = $1`, [p.id]],
      ['void without version', `UPDATE supplier_payments SET status = 'voided', "voidedAt" = now(), "voidedById" = "recordedById", "voidReason" = 'r' WHERE id = $1`, [p.id]],
      ['void fields without status', `UPDATE supplier_payments SET "voidReason" = 'r' WHERE id = $1`, [p.id]],
      ['delete', `DELETE FROM supplier_payments WHERE id = $1`, [p.id]],
      ['truncate', `TRUNCATE supplier_payments`, []],
      ['item inactive while recorded', `UPDATE supplier_payment_items SET active = false WHERE "supplierPaymentId" = $1`, [p.id]],
      ['item amount', `UPDATE supplier_payment_items SET "amountMinor" = 1 WHERE "supplierPaymentId" = $1`, [p.id]],
      ['item delete', `DELETE FROM supplier_payment_items WHERE "supplierPaymentId" = $1`, [p.id]],
      ['item added later', `INSERT INTO supplier_payment_items (id, "supplierPaymentId", mode, "costItemId", "amountMinor", currency) VALUES (gen_random_uuid(), $1, 'test', $2, 760400, 'DKK')`, [p.id, c.id]],
    ];
    for (const [name, sql, params] of cases) expect([name, await txError(app, [[sql, params]])]).not.toEqual([name, null]);
    // After a void, the void fields and the version are frozen, and an item cannot come back.
    must(await voidIt(p.id, { version: p.version, reason: 'Mistake' }), 'void');
    expect(await txError(app, [[`UPDATE supplier_payments SET "voidReason" = 'other' WHERE id = $1`, [p.id]]])).not.toBeNull();
    expect(await txError(app, [[`UPDATE supplier_payments SET version = version + 1 WHERE id = $1`, [p.id]]])).not.toBeNull();
    expect(await txError(app, [[`UPDATE supplier_payments SET status = 'recorded', version = version + 1 WHERE id = $1`, [p.id]]])).not.toBeNull();
    expect(await txError(app, [[`UPDATE supplier_payment_items SET active = true WHERE "supplierPaymentId" = $1`, [p.id]]])).not.toBeNull();
    expect((await app.query(`SELECT has_table_privilege('mt_app', 'supplier_payments', 'DELETE') AS d, has_table_privilege('mt_app', 'supplier_payment_items', 'TRUNCATE') AS t`)).rows[0]).toEqual({ d: false, t: false });
    expect(s.id).toBeTruthy();
  });

  it('cost_paid_iff_active_payment_item and cost_item_cannot_be_paid_twice by SQL', async () => {
    const { s, c } = await recorded();
    const due = await newCost(s.id);
    expect(await txError(app, [[`UPDATE cost_items SET status = 'paid' WHERE id = $1`, [due.id]]])).toBe('23514');
    expect(await txError(app, [[`UPDATE cost_items SET status = 'due' WHERE id = $1`, [c.id]]])).toBe('23514');
    // A second live item for a paid cost: the partial unique index.
    const id = randomUUID();
    const staff = admin.staff.id;
    expect(await txError(app, [
      [`INSERT INTO supplier_payments (id, "supplierId", mode, "amountMinor", currency, "paidOn", reference, "idempotencyKey", "recordedById") VALUES ($1, $2, 'test', 760400, 'DKK', current_date, 'x', $3, $4)`, [id, s.id, `t-${id}`, staff]],
      [`INSERT INTO supplier_payment_items (id, "supplierPaymentId", mode, "costItemId", "amountMinor", currency) VALUES (gen_random_uuid(), $1, 'test', $2, 760400, 'DKK')`, [id, c.id]],
    ])).toBe('23505');
  });

  it('supplier_payment_items_sum_to_payment, whole-cost items, the supplier\'s own costs (deferred and row checks)', async () => {
    const s = await newSupplier();
    const s2 = await newSupplier();
    const c = await newCost(s.id);
    const foreign = await newCost(s2.id);
    const staff = admin.staff.id;
    const insertPayment = (id: string, amount: number, supplierId = s.id): [string, unknown[]] => [
      `INSERT INTO supplier_payments (id, "supplierId", mode, "amountMinor", currency, "paidOn", reference, "idempotencyKey", "recordedById") VALUES ($1, $2, 'test', $3, 'DKK', current_date, 'x', $4, $5)`, [id, supplierId, amount, `t-${id}`, staff],
    ];
    const insertItem = (pid: string, costId: string, amount: number): [string, unknown[]] => [
      `INSERT INTO supplier_payment_items (id, "supplierPaymentId", mode, "costItemId", "amountMinor", currency) VALUES (gen_random_uuid(), $1, 'test', $2, $3, 'DKK')`, [pid, costId, amount],
    ];
    const paid: [string, unknown[]] = [`UPDATE cost_items SET status = 'paid', version = version + 1 WHERE id = $1`, [c.id]];
    let id = randomUUID();
    expect(await txError(app, [insertPayment(id, 760401), insertItem(id, c.id, 760400), paid])).toBe('23514');
    id = randomUUID();
    expect(await txError(app, [insertPayment(id, 760400)])).toBe('23514');
    id = randomUUID();
    expect(await txError(app, [insertPayment(id, 100), insertItem(id, c.id, 100), paid])).toBe('23514');
    id = randomUUID();
    expect(await txError(app, [insertPayment(id, 760400), insertItem(id, foreign.id, 760400)])).toBe('23514');
    // An item in another mode than its payment: the composite foreign key.
    id = randomUUID();
    const [livePayment, liveParams] = insertPayment(id, 760400);
    expect(await txError(app, [[livePayment.replace("'test'", "'live'"), liveParams], insertItem(id, c.id, 760400)])).toBe('23503');
    expect(await costStatus(c.id)).toBe('planned');
  });

  it('ledger_check_finds_missing_supplier_payment_posting and leaves good booking-less postings alone', async () => {
    const { p } = await recorded();
    const check = t.app.get(PaymentLedgerCheckService);
    const findings = await check.check();
    const txIds = (await t.prisma.ledgerTransaction.findMany({ where: { supplierPaymentId: p.id }, select: { id: true } })).map((x) => x.id);
    expect(txIds.length).toBe(1);
    expect(findings.filter((f) => f.entityId === p.id || txIds.includes(f.entityId) || f.kind === 'missing_supplier_payment_posting')).toEqual([]);
    // A live-mode payment written by hand without its posting (kept out of every test-mode figure).
    const s = await newSupplier();
    const c = await newCost(s.id);
    const id = randomUUID();
    expect(await txError(app, [
      [`INSERT INTO supplier_payments (id, "supplierId", mode, "amountMinor", currency, "paidOn", reference, "idempotencyKey", "recordedById") VALUES ($1, $2, 'live', 760400, 'DKK', current_date, 'x', $3, $4)`, [id, s.id, `t-${id}`, admin.staff.id]],
      [`INSERT INTO supplier_payment_items (id, "supplierPaymentId", mode, "costItemId", "amountMinor", currency) VALUES (gen_random_uuid(), $1, 'live', $2, 760400, 'DKK')`, [id, c.id]],
      [`UPDATE cost_items SET status = 'paid', version = version + 1 WHERE id = $1`, [c.id]],
    ])).toBeNull();
    // In test mode that live payment cannot be read or voided (code review, m6).
    expect((await admin.get(`/admin/suppliers/payments/${id}`)).status).toBe(404);
    expect((await voidIt(id, { version: 0, reason: 'Mistake' })).status).toBe(404);
    expect((await admin.get(`/admin/suppliers/${s.id}/payments`)).body.items).toEqual([]);
    const spy = vi.spyOn(t.app.get(ProviderGateway), 'mode', 'get').mockReturnValue('live');
    try {
      expect((await check.check()).filter((f) => f.entityId === id)).toEqual([{ kind: 'missing_supplier_payment_posting', entityType: 'SupplierPayment', entityId: id }]);
      expect((await admin.get(`/admin/suppliers/payments/${id}`)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('a paid cost is frozen (guard 6): no new amount, trip, supplier or currency; its description may change', async () => {
    const { c } = await recorded();
    const other = await buildWorld(admin);
    const otherSupplier = await newSupplier();
    for (const sql of [
      `UPDATE cost_items SET "amountMinor" = "amountMinor" + 1 WHERE id = $1`, `UPDATE cost_items SET quantity = quantity + 1 WHERE id = $1`,
      `UPDATE cost_items SET "unitAmountMinor" = "unitAmountMinor" + 1 WHERE id = $1`, `UPDATE cost_items SET "packageId" = '${other.pkg.id}' WHERE id = $1`,
      `UPDATE cost_items SET "packageId" = NULL WHERE id = $1`,
      `UPDATE cost_items SET "supplierId" = '${otherSupplier.id}' WHERE id = $1`, `UPDATE cost_items SET currency = 'EUR' WHERE id = $1`,
    ]) expect([sql, await txError(app, [[sql, [c.id]]])]).toEqual([sql, '42501']);
    expect(await txError(app, [[`UPDATE cost_items SET description = 'Renamed' WHERE id = $1`, [c.id]]])).toBeNull();
  });

  it('ledger rows of a supplier payment: no booking, its currencies only, the same mode, a reversal of the same payment', async () => {
    const { p } = await recorded();
    const { p: q } = await recorded();
    const original = (await t.prisma.ledgerTransaction.findFirstOrThrow({ where: { supplierPaymentId: p.id } })).id;
    const tx = (id: string, over: { kind?: string; mode?: string; spId?: string; bookingId?: string; reverses?: string } = {}) =>
      `INSERT INTO ledger_transactions (id, kind, mode, "supplierPaymentId", "bookingId", "reversesTransactionId", "idempotencyKey", description, "contentSha256")
       VALUES ('${id}', '${over.kind ?? 'supplier_payment'}', '${over.mode ?? 'test'}', '${over.spId ?? p.id}', ${over.bookingId ? `'${over.bookingId}'` : 'NULL'}, ${over.reverses ? `'${over.reverses}'` : 'NULL'}, 't-${id}', 'x', repeat('0', 64))`;
    const entry = (id: string, cur: string, amount: number) => `INSERT INTO ledger_entries (id, "transactionId", mode, "accountCode", currency, "amountMinor") VALUES (gen_random_uuid(), '${id}', 'test', 'supplier_payable', '${cur}', ${amount})`;
    await app.query(`INSERT INTO ledger_accounts (id, code, kind, currency, mode) VALUES (gen_random_uuid(), 'supplier_payable', 'liability', 'NZD', 'test') ON CONFLICT DO NOTHING`);
    const booking = await t.prisma.booking.findFirst({ select: { id: true } });
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const cases: Array<[string, string[], string]> = [
      ['live mode for a test payment', [tx(ids[0]!, { mode: 'live' })], '23503'],
      ['a third currency', [tx(ids[1]!), entry(ids[1]!, 'NZD', 5), entry(ids[1]!, 'NZD', -5)], '23514'],
      ['a reversal carrying another payment', [tx(ids[2]!, { kind: 'reversal', spId: q.id, reverses: original })], '23514'],
      ['a supplier posting that reverses something', [tx(ids[3]!, { reverses: original })], '23514'],
    ];
    if (booking) cases.push(['with a booking', [tx(ids[4]!, { bookingId: booking.id })], '23514']);
    for (const [name, sqls, code] of cases) expect([name, await txError(app, sqls.map((x) => [x]))]).toEqual([name, code]);
  });
});
