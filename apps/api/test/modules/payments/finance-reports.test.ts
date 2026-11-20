// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md): the result per trip, the cash forecast and the accountant export,
// through the real flows (simulator payments, a cancellation with a penalty, supplier costs and payments, typed bank amounts).
// The database is shared with other test files, so every figure is read for this file's own trips, or as a difference.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { AccountantExportService } from '../../../src/modules/payments/core/accountant-export.service';
import { CashForecastService } from '../../../src/modules/payments/core/cash-forecast.service';
import { impliedRateE9 } from '../../../src/modules/payments/core/fx';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { AuditService } from '../../../src/platform/audit/audit.service';
import { parseCsv } from '../../../src/platform/common/csv';
import { PAYMENTS_PERMISSIONS } from '../../../src/modules/payments/manifest';
import { TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents, requestBody, staffCancel } from '../../support/bookings';
import { CATALOGUE_AND_PRICING, closeCatalogue } from '../../support/catalogue';
import { activePolicy, assignPolicy, pct } from '../../support/cancellations';
import {
  ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, acceptCurrentTerms, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, sim, simulatorAccount,
} from '../../support/payments';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import { ALL_SUPPLIER_PERMISSIONS, adminWith, must, setSuppliersFlag, supplierBody } from '../../support/suppliers';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type Staff = Awaited<ReturnType<typeof adminWith>>;
let t: TestApp;
let admin: Staff;
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  await setSuppliersFlag(t, true);
  admin = await adminWith(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS, ...ALL_SUPPLIER_PERMISSIONS]);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
const key = () => `k-${randomUUID()}`;
const P = PAYMENTS_PERMISSIONS;

async function supplier(currency = 'AUD') {
  return must(await admin.post('/admin/suppliers', supplierBody({ name: `Hotel ${randomUUID().slice(0, 6)}`, countryCode: 'AU', defaultCurrency: currency })), 'supplier').body as { id: string };
}
async function cost(supplierId: string, packageId: string | null, unitAmountMinor: string, currency = 'AUD', dueDate: string | null = null) {
  return must(await admin.post(`/admin/suppliers/${supplierId}/costs`, { description: 'Rooms', basis: 'fixed', quantity: 1, unitAmountMinor, currency, packageId, ...(dueDate ? { dueDate } : {}) }), 'cost').body as { id: string; version: number };
}
async function pay(supplierId: string, costs: Array<{ id: string; version: number }>, base?: { amountMinor: string; currency: string }, reference = 'INV-SECRET-9') {
  return must(await admin.post(`/admin/suppliers/${supplierId}/payments`, { items: costs.map((x) => ({ costItemId: x.id, version: x.version })), paidOn: today(), reference, ...(base ? { base } : {}) }).set('Idempotency-Key', key()), 'pay').body as { id: string; version: number };
}

async function policyWorld(pctBps = 5000): Promise<{ w: PricedWorld; policy: { id: string; digest: string } }> {
  const w = await pricedWorld(admin);
  const policy = await activePolicy(admin, [pct(0, pctBps)]);
  await assignPolicy(admin, w.pkg.id, policy.id);
  return { w, policy };
}
async function approved(who: PayingCustomer, w: PricedWorld, policy: { id: string; digest: string } | null, approve = true) {
  const res = await who.request(requestBody(w, { cancellationPolicy: policy }));
  expect(res.status).toBe(201);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string } });
  if (approve) {
    expect((await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version })).status).toBe(200);
    await acceptCurrentTerms(t, who, b.reference);
  }
  return { reference: b.reference, bookingId: b.id };
}
async function payUpTo(reference: string, bookingId: string, upTo?: number) {
  expect((await c.pay(reference, { method: 'card', ...(upTo ? { upToSequence: upTo } : {}) })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, acc, await eventFor(t, acc, p.id))).outcome).toBe('processed');
  return t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
}

type Money = Record<string, string | boolean | number | null | Record<string, unknown>>;
interface Row { packageId: string; trip: string; currency: string; result: Money & { otherCurrencies: Array<Record<string, string>>; warnings: Record<string, boolean>; refundedByPurpose: Record<string, string> } }
interface Report {
  rows: Row[]; totals: Array<Record<string, string | number>>; unlinked: Array<{ currency: string; costMinor: string; paidMinor: string; unpaidMinor: string }>;
  reconciliation: Array<{ name: string; currency: string; reportedMinor: string; ledgerMinor: string; matches: boolean }>;
  fx: { pairs: Array<{ supplierCurrency: string; bankCurrency: string; payments: number; supplierAmountMinor: string; bankAmountMinor: string; averageRateE9: string }>; ledger: Array<{ currency: string; matches: boolean }> };
}
const report = async (who: Staff = admin) => must(await who.get('/admin/payments/reports/trip-result'), 'report').body as Report;
const rowOf = (r: Report, packageId: string) => r.rows.find((x) => x.packageId === packageId)!;
const big = (v: unknown) => BigInt(v as string);

describe('the result of a trip (plan section 3)', () => {
  it('trip_result_with_penalty_refund_and_costs: revenue earned, penalties kept, refunds, costs per currency, and the checks against the ledger', async () => {
    const { w, policy } = await policyWorld();
    const stays = await approved(c, w, policy);
    const stayAmount = (await payUpTo(stays.reference, stays.bookingId)).amountMinor;
    const gone = await approved(c, w, policy);
    const goneAmount = (await payUpTo(gone.reference, gone.bookingId)).amountMinor;
    const b1 = await t.prisma.booking.findUniqueOrThrow({ where: { id: stays.bookingId } });
    const b2 = await t.prisma.booking.findUniqueOrThrow({ where: { id: gone.bookingId } });
    expect((await staffCancel(admin, gone.bookingId, { version: b2.version, reason: 'Customer asked' })).status).toBe(200);
    const cx = (await t.prisma.cancellation.findUniqueOrThrow({ where: { bookingId: gone.bookingId } }));
    // A refund of what the cancellation does not keep (the simulator may settle it at once or later: the report follows the ledger).
    const p2 = (await t.prisma.payment.findMany({ where: { bookingId: gone.bookingId } }))[0]!;
    const refund = await admin.post(`/admin/payments/payments/${p2.id}/refunds`, { paymentVersion: p2.version, purpose: 'cancellation', reason: 'Cancelled, penalty kept' }).set('Idempotency-Key', key());
    expect(refund.status).toBe(201);

    const own = await supplier('AUD');
    const rooms = await cost(own.id, w.pkg.id, '30000');
    await cost(own.id, w.pkg.id, '8000');
    await pay(own.id, [rooms]);
    const sek = await supplier('SEK');
    // Both amounts typed from the bank statement, one trip, the bank currency is the trip's: counted, with the bank's amount.
    await pay(sek.id, [await cost(sek.id, w.pkg.id, '12000', 'SEK')], { amountMinor: '2000', currency: 'AUD' });
    await cost(sek.id, w.pkg.id, '4000', 'SEK');
    const jpy = await supplier('JPY');
    await pay(jpy.id, [await cost(jpy.id, w.pkg.id, '5000', 'JPY')]);

    const r = await report();
    const row = rowOf(r, w.pkg.id);
    const x = row.result;
    const refunds = await t.prisma.refund.findMany({ where: { bookingId: gone.bookingId, status: 'succeeded' } });
    const refundedNow = refunds.reduce((s, f) => s + f.amountMinor, 0n);
    const overNow = goneAmount - cx.penaltyMinor - refundedNow;
    expect(row.currency).toBe('AUD');
    expect([x.bookings, x.cancelledBookings]).toEqual([2, 1]);
    expect(cx.basis).toBe('policy');
    expect(big(x.keptMinor)).toBe(stayAmount + cx.penaltyMinor);
    expect(big(x.earnedRevenueMinor)).toBe(cx.penaltyMinor);
    expect(big(x.penaltiesKeptMinor)).toBe(cx.penaltyMinor);
    expect(big(x.notYetEarnedMinor)).toBe(stayAmount);
    expect(big(x.refundedMinor)).toBe(refundedNow);
    expect(big(x.overpaymentsMinor)).toBe(overNow);
    expect(big(x.expectedRevenueMinor)).toBe(b1.totalMinor + cx.penaltyMinor);
    expect([x.costCommittedMinor, x.costPaidMinor, x.costUnpaidMinor]).toEqual(['38000', '30000', '8000']);
    const sekRow = x.otherCurrencies.find((o) => o.currency === 'SEK')!;
    expect(sekRow).toMatchObject({ committedMinor: '16000', paidMinor: '12000', unpaidMinor: '4000', explicitPaidMinor: '12000', explicitDebitedMinor: '2000', leftOutMinor: '4000' });
    expect(x.otherCurrencies.find((o) => o.currency === 'JPY')).toMatchObject({ committedMinor: '5000', paidMinor: '5000', explicitPaidMinor: '0', explicitDebitedMinor: '0', leftOutMinor: '5000' });
    // Counted in the result: the trip's own costs and the typed bank amount. SEK and JPY are never converted.
    expect([x.costInResultMinor, x.costPaidInResultMinor]).toEqual(['40000', '32000']);
    expect(big(x.resultCashMinor)).toBe(big(x.keptMinor) - big(x.feesMinor) - 32_000n);
    expect(big(x.resultExpectedMinor)).toBe(big(x.expectedRevenueMinor) - big(x.feesMinor) - 40_000n);
    expect(x.resultEarnedMinor).toBeNull();
    expect(x.warnings).toMatchObject({ otherCurrencyLeftOut: true, noSupplierCosts: false });
    expect(x.trip ?? row.trip).toContain('Test Marathon');
    // The ledger agrees with the trip's own money.
    expect(await t.app.get(PaymentLedgerCheckService).check({ bookingIds: [stays.bookingId, gone.bookingId] })).toEqual([]);
    // The whole report adds up to the ledger and to the cost items (criterion "cuadra con el libro y con los costes").
    expect(r.reconciliation.filter((l) => !l.matches)).toEqual([]);
    expect(r.reconciliation.map((l) => l.name)).toEqual(expect.arrayContaining(['customer_money', 'fees', 'supplier_paid', 'costs']));
    expect(r.fx.ledger.filter((l) => !l.matches)).toEqual([]);
  });

  it('typed_conversion_needs_one_trip_and_the_trips_currency: two trips in one payment, or a third bank currency, stay out', async () => {
    const a = await pricedWorld(admin);
    const b = await pricedWorld(admin);
    const nok = await supplier('NOK');
    const both = await pay(nok.id, [await cost(nok.id, a.pkg.id, '3000', 'NOK'), await cost(nok.id, b.pkg.id, '2000', 'NOK')], { amountMinor: '900', currency: 'AUD' });
    expect(both.id).toBeTruthy();
    const dkk = await supplier('DKK');
    await pay(dkk.id, [await cost(dkk.id, a.pkg.id, '1000', 'DKK')], { amountMinor: '200', currency: 'EUR' });
    const r = await report();
    for (const w of [a, b]) {
      const row = rowOf(r, w.pkg.id);
      expect(row.result.costInResultMinor).toBe('0');
      expect(row.result.warnings.otherCurrencyLeftOut).toBe(true);
    }
    expect(rowOf(r, a.pkg.id).result.otherCurrencies.map((o) => [o.currency, o.explicitDebitedMinor])).toEqual([['DKK', '0'], ['NOK', '0']]);
    // A prepayment-only trip is a row, and a loss so far in its own currency (nothing was received).
    const own = await supplier('AUD');
    await pay(own.id, [await cost(own.id, b.pkg.id, '700')]);
    const after = rowOf(await report(), b.pkg.id).result;
    expect([after.bookings, after.resultCashMinor, after.settled, after.resultEarnedMinor]).toEqual([0, '-700', false, null]);
  });

  it('fx_read: pairs per currency, the implied rate respects the decimal places, and the ledger agrees (finding 3)', async () => {
    const before = (await report()).fx.pairs.find((p) => p.supplierCurrency === 'JPY' && p.bankCurrency === 'AUD');
    const w = await pricedWorld(admin);
    const jpy = await supplier('JPY');
    // 10 000 yen cost, the bank took 100.00 AUD: 0.01 AUD per yen.
    const p1 = await pay(jpy.id, [await cost(jpy.id, w.pkg.id, '10000', 'JPY')], { amountMinor: '10000', currency: 'AUD' });
    const mid = await report();
    const pair = mid.fx.pairs.find((p) => p.supplierCurrency === 'JPY' && p.bankCurrency === 'AUD')!;
    const dSupplier = big(pair.supplierAmountMinor) - big(before?.supplierAmountMinor ?? '0');
    const dBank = big(pair.bankAmountMinor) - big(before?.bankAmountMinor ?? '0');
    expect([dSupplier, dBank]).toEqual([10_000n, 10_000n]);
    expect(pair.averageRateE9).toBe(impliedRateE9(big(pair.supplierAmountMinor), 'JPY', big(pair.bankAmountMinor), 'AUD').toString());
    expect(impliedRateE9(10_000n, 'JPY', 10_000n, 'AUD')).toBe(10_000_000n);
    expect(mid.fx.ledger.filter((l) => !l.matches)).toEqual([]);
    // Voided: it leaves the read, and the ledger's reversal keeps the two in step.
    must(await admin.post(`/admin/suppliers/payments/${p1.id}/void`, { version: p1.version, reason: 'Mistake' }).set('Idempotency-Key', key()), 'void');
    const end = await report();
    const left = end.fx.pairs.find((p) => p.supplierCurrency === 'JPY' && p.bankCurrency === 'AUD');
    expect(big(left?.supplierAmountMinor ?? '0')).toBe(big(before?.supplierAmountMinor ?? '0'));
    expect(end.fx.ledger.filter((l) => !l.matches)).toEqual([]);
    expect(end.reconciliation.filter((l) => !l.matches)).toEqual([]);
    expect(rowOf(end, w.pkg.id).result.costPaidMinor).toBe('0');
  });

  it('test_mode_rows_not_in_production: with the live mode the trip is not there', async () => {
    const w = await pricedWorld(admin);
    const s = await supplier();
    await pay(s.id, [await cost(s.id, w.pkg.id, '4000')]);
    const spy = vi.spyOn(t.app.get(ProviderGateway), 'mode', 'get').mockReturnValue('live');
    try {
      const live = await report();
      expect(live.rows.find((x) => x.packageId === w.pkg.id)?.result.costPaidMinor ?? '0').toBe('0');
    } finally {
      spy.mockRestore();
    }
  });

  it('result_access: the permission, no step-up for the read, nothing for others', async () => {
    const none = await adminWith(t, []);
    const reader = await adminWith(t, [P.tripResultReport]);
    expect((await none.get('/admin/payments/reports/trip-result')).status).toBe(403);
    expect((await reader.get('/admin/payments/reports/trip-result')).status).toBe(200);
    expect((await reader.get('/admin/payments/reports/trip-result')).headers['cache-control']).toMatch(/no-store/);
    expect((await reader.get('/admin/payments/reports/cash-forecast')).status).toBe(403);
  });
});

describe('the cash forecast (plan section 4)', () => {
  it('forecast_expects_only_what_is_unpaid: instalments left, tentative bookings apart, per trip, per currency', async () => {
    const { w, policy } = await policyWorld();
    const live = await approved(c, w, policy);
    const dep = await payUpTo(live.reference, live.bookingId, 1);
    const tentative = await approved(c, w, policy);
    const b1 = await t.prisma.booking.findUniqueOrThrow({ where: { id: live.bookingId } });
    const b2 = await t.prisma.booking.findUniqueOrThrow({ where: { id: tentative.bookingId } });
    const s = await supplier();
    await cost(s.id, w.pkg.id, '9000', 'AUD', '2027-01-15');
    await cost(s.id, w.pkg.id, '1000');
    const f = must(await admin.get('/admin/payments/reports/cash-forecast?from=2026-01-01&to=2027-12-31'), 'forecast').body as {
      currencies: Array<{ currency: string; days: Array<Record<string, string>>; undated: Record<string, string>; customerDebtMinor: string; toGiveBackMinor: string; refundsInFlightMinor: string }>;
      trips: Array<{ packageId: string | null; currency: string; instalmentsInMinor: string; tentativeInMinor: string; supplierOutMinor: string; firmNetMinor: string }>;
    };
    const trip = f.trips.find((x) => x.packageId === w.pkg.id)!;
    expect(trip).toMatchObject({ currency: 'AUD', instalmentsInMinor: (b1.totalMinor - dep.amountMinor).toString(), tentativeInMinor: b2.totalMinor.toString(), supplierOutMinor: '10000' });
    expect(trip.firmNetMinor).toBe((b1.totalMinor - dep.amountMinor - 10_000n).toString());
    const aud = f.currencies.find((x) => x.currency === 'AUD')!;
    expect(aud.days.find((d) => d.date === '2027-01-15')!.supplierOutMinor).not.toBe('0');
    for (const k of ['customerDebtMinor', 'toGiveBackMinor', 'refundsInFlightMinor'] as const) expect(aud[k]).toMatch(/^\d+$/);
    // Every row's net is instalments less suppliers, nothing else, and the running figure is the sum of the nets.
    let running = 0n;
    for (const d of aud.days) {
      expect(big(d.firmNetMinor)).toBe(big(d.instalmentsInMinor) - big(d.supplierOutMinor));
      running += big(d.firmNetMinor);
      expect(big(d.runningNetMinor)).toBe(running);
    }
  });

  it('forecast_brisbane_dates: a payment due today is due until the end of the day in Brisbane (13:59:59.999Z and 14:00Z)', async () => {
    // A date of its own (the database is shared and costs stay), a few years ahead of every other test's dates.
    const day = new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 3000) * 86_400_000).toISOString().slice(0, 10);
    const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const s = await supplier('CAD');
    const w = await pricedWorld(admin);
    await cost(s.id, w.pkg.id, '1234', 'CAD', day);
    const svc = t.app.get(CashForecastService);
    const at = async (iso: string) => (await svc.forecast({ currency: 'CAD' }, new Date(iso))).currencies.find((x) => x.currency === 'CAD')!;
    const last = await at(`${day}T13:59:59.999Z`);
    expect(last.days.map((d) => d.date)).toEqual([day]);
    const next = await at(`${day}T14:00:00.000Z`);
    expect(next.days.map((d) => d.date)).not.toContain(day);
    expect(next.overdue.supplierOutMinor - last.overdue.supplierOutMinor).toBe(1234n);
    const early = await at(`${prev}T14:00:00.000Z`);
    expect(early.days.map((d) => d.date)).toEqual([day]);
  });

  it('forecast_range_and_access: 422 for a backwards or over-long range, an unknown field and a bad currency; 403 without the permission', async () => {
    for (const q of ['from=2026-12-05&to=2026-12-04', 'from=2026-01-01&to=2029-01-01', 'colour=red', 'currency=aud', 'from=tomorrow']) {
      expect((await admin.get(`/admin/payments/reports/cash-forecast?${q}`)).status).toBe(422);
    }
    expect((await (await adminWith(t, [])).get('/admin/payments/reports/cash-forecast')).status).toBe(403);
    expect((await (await adminWith(t, [P.cashForecastReport])).get('/admin/payments/reports/cash-forecast')).status).toBe(200);
  });
});

describe('the accountant export (plan section 5)', () => {
  const body = (dataset: string, over: Record<string, unknown> = {}) => ({ dataset, from: '2026-01-01', to: '2026-12-31', ...over });
  const file = (who: Staff, b: object) => who.post('/admin/payments/exports/accountant', b);
  const rowsOf = (res: { text: string }) => parseCsv(res.text);

  it('export_requires_permission_and_step_up; not for an API key', async () => {
    const none = await adminWith(t, []);
    expect((await file(none, body('trip_result'))).status).toBe(403);
    const holder = await adminWith(t, [P.accountantExport]);
    expect((await file(holder, body('trip_result'))).status).toBe(200);
    const stale = await adminWith(t, [P.accountantExport]);
    await t.prisma.session.updateMany({ where: { userId: stale.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const r = await file(stale, body('trip_result'));
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    expect(await t.prisma.auditLog.count({ where: { actorId: stale.staff.id, action: 'exports.accountant.generated' } })).toBe(0);
    const def = (await import('../../../src/modules/payments/manifest')).paymentsManifest.permissions.find((x) => x.key === P.accountantExport)!;
    expect([def.requiresStepUp, def.apiKeyScopable]).toEqual([true, false]);
    for (const k of [P.tripResultReport, P.cashForecastReport]) expect((await import('../../../src/modules/payments/manifest')).paymentsManifest.permissions.find((x) => x.key === k)!.apiKeyScopable).toBe(false);
  });

  it.each([
    [{ dataset: 'everything' }], [{ from: '2026-12-31', to: '2026-01-01' }], [{ from: '2026-01-01', to: '2027-01-02' }], [{ extra: 1 }], [{ from: 'yesterday' }], [{ dataset: undefined }],
  ])('export_rejects_bad_requests %j: 422, nothing audited', async (over) => {
    const holder = await adminWith(t, [P.accountantExport]);
    const r = await file(holder, body('trip_result', over));
    expect(r.status).toBe(422);
    expect(await t.prisma.auditLog.count({ where: { actorId: holder.staff.id, action: 'exports.accountant.generated' } })).toBe(0);
  });

  it('trip_result_file: header, the trip, exact decimals, guarded text, audit with no values', async () => {
    const { w, policy } = await policyWorld();
    await t.prisma.race.update({ where: { id: w.race.id }, data: { name: { 'en-AU': '=HYPERLINK("http://example.test","x")' } } });
    const bk = await approved(c, w, policy);
    const paid = (await payUpTo(bk.reference, bk.bookingId)).amountMinor;
    const s = await supplier('JPY');
    await pay(s.id, [await cost(s.id, w.pkg.id, '5000', 'JPY')], undefined, 'INV-SECRET-REF');
    const holder = await adminWith(t, [P.accountantExport]);
    const res = await file(holder, body('trip_result'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="?marathon-trips-trip-result-20260101-20261231\.csv/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const rows = rowsOf(res);
    const header = rows[0]!;
    expect(header.slice(0, 3)).toEqual(['Environment', 'Trip', 'Currency']);
    const mine = rows.find((r) => r[1]!.includes('HYPERLINK'))!;
    expect(mine[1]!.startsWith("'=")).toBe(true);
    const col = (name: string) => mine[header.indexOf(name)]!;
    const dec = (v: bigint) => `${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
    expect(col('Currency')).toBe('AUD');
    expect(col('Customer money kept')).toBe(dec(paid));
    expect(col('Costs in other currencies (not converted)')).toBe('JPY 5000 recorded, 5000 paid');
    expect(col('Result complete')).toBe('No');
    expect(col('Environment')).toBe('test');
    // No formula can start in any cell, whichever separator a reader uses, and no staff-typed text is in the file.
    for (const frag of res.text.slice(1).split(/[,;\r\n]/)) expect(frag.replace(/^["\s]*/, '')).not.toMatch(/^[=+@\t]/);
    expect(res.text).not.toMatch(/INV-SECRET/);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { actorId: holder.staff.id, action: 'exports.accountant.generated' } });
    const json = JSON.stringify(audit);
    expect(json).toContain('trip_result');
    expect(json).not.toMatch(/HYPERLINK|INV-SECRET|Hotel/);
    expect(await t.prisma.$queryRaw`SELECT 1 FROM audit_pii_values WHERE "auditLogId" = ${audit.id}::uuid`).toEqual([]);
  });

  it('ledger_file: debit equals credit per currency over whole transactions, supplier named, no staff text', async () => {
    const { w, policy } = await policyWorld();
    const bk = await approved(c, w, policy);
    await payUpTo(bk.reference, bk.bookingId);
    const s = await supplier('AUD');
    const p = await pay(s.id, [await cost(s.id, w.pkg.id, '2500')], undefined, 'INV-SECRET-LEDGER');
    const holder = await adminWith(t, [P.accountantExport]);
    const todayIso = today();
    const res = await file(holder, body('ledger', { from: todayIso, to: todayIso }));
    expect(res.status).toBe(200);
    const rows = rowsOf(res);
    const h = rows[0]!;
    expect(h).toEqual(['Environment', 'Date (Brisbane)', 'Transaction', 'Kind', 'Account', 'Currency', 'Debit', 'Credit', 'Booking reference', 'Trip', 'Supplier']);
    const byTx = new Map<string, bigint>();
    const toMinor = (v: string) => BigInt(v.replace('.', ''));
    for (const r of rows.slice(1)) {
      expect(r[1]).toBe(todayIso);
      const net = (r[6] ? toMinor(r[6]) : 0n) - (r[7] ? toMinor(r[7]) : 0n);
      byTx.set(`${r[2]}|${r[5]}`, (byTx.get(`${r[2]}|${r[5]}`) ?? 0n) + net);
    }
    for (const [k, v] of byTx) expect([k, v]).toEqual([k, 0n]);
    const mine = rows.filter((r) => r[2] === `supplier_payment:${p.id}`);
    expect(mine.map((r) => [r[3], r[4], r[6] || r[7]])).toEqual(expect.arrayContaining([['supplier_payment', 'supplier_payable', '25.00'], ['supplier_payment', 'bank', '25.00']]));
    expect(mine[0]![10]).toMatch(/^Hotel /);
    const booked = rows.filter((r) => r[8] === bk.reference);
    expect(booked.length).toBeGreaterThan(0);
    expect(res.text).not.toMatch(/INV-SECRET/);
    // A day with no movement is only the header.
    const empty = await file(holder, body('ledger', { from: '2020-01-01', to: '2020-01-02' }));
    expect(rowsOf(empty)).toHaveLength(1);
  });

  it('supplier_payments_file: recorded and voided, bank amount and implied rate, trip only when one, no reference or reason', async () => {
    const w = await pricedWorld(admin);
    const s = await supplier('JPY');
    const keep = await pay(s.id, [await cost(s.id, w.pkg.id, '10000', 'JPY')], { amountMinor: '10000', currency: 'AUD' }, 'INV-SECRET-A');
    const gone = await pay(s.id, [await cost(s.id, null, '300', 'JPY')], undefined, 'INV-SECRET-B');
    must(await admin.post(`/admin/suppliers/payments/${gone.id}/void`, { version: gone.version, reason: 'Secret reason text' }).set('Idempotency-Key', key()), 'void');
    const holder = await adminWith(t, [P.accountantExport]);
    const todayIso = today();
    const res = await file(holder, body('supplier_payments', { from: todayIso, to: todayIso }));
    expect(res.status).toBe(200);
    const rows = rowsOf(res);
    const h = rows[0]!;
    const mine = rows.filter((r) => r[3] === rows.find((x) => x[0] === 'test' && x[3]!.startsWith('Hotel') && x[4] === 'recorded' && x[5] === 'JPY' && x[6] === '10000')![3]);
    const rec = mine.find((r) => r[4] === 'recorded')!;
    expect([rec[h.indexOf('Currency')], rec[h.indexOf('Amount')], rec[h.indexOf('Bank currency')], rec[h.indexOf('Bank amount')], rec[h.indexOf('Implied rate (bank currency per supplier currency)')]]).toEqual(['JPY', '10000', 'AUD', '100.00', '0.010000000']);
    expect(rec[h.indexOf('Trip')]).toContain('Test Marathon');
    const voided = mine.find((r) => r[4] === 'voided')!;
    expect(voided[h.indexOf('Trip')]).toBe('');
    expect(res.text).not.toMatch(/INV-SECRET|Secret reason/);
    expect(keep.id).toBeTruthy();
  });

  it('export_too_large_and_no_audit_no_file', async () => {
    const holder = await adminWith(t, [P.accountantExport]);
    const svc = t.app.get(AccountantExportService);
    const was = svc.maxRows;
    svc.maxRows = 0;
    try {
      const big = await file(holder, body('trip_result'));
      expect([big.status, big.body.code]).toEqual([422, 'export_too_large']);
    } finally {
      svc.maxRows = was;
    }
    expect(await t.prisma.auditLog.count({ where: { actorId: holder.staff.id, action: 'exports.accountant.generated' } })).toBe(0);
    // If the audit entry cannot be written, no file leaves.
    const spy = vi.spyOn(t.app.get(AuditService), 'record').mockRejectedValue(new Error('audit down'));
    try {
      const r = await file(holder, body('trip_result'));
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(r.text).not.toMatch(/Environment/);
    } finally {
      spy.mockRestore();
    }
    expect(await t.prisma.auditLog.count({ where: { actorId: holder.staff.id, action: 'exports.accountant.generated' } })).toBe(0);
    const ok = await file(holder, body('trip_result'));
    expect(ok.status).toBe(200);
    const entry = await t.prisma.auditLog.findFirstOrThrow({ where: { actorId: holder.staff.id, action: 'exports.accountant.generated' } });
    expect(JSON.stringify(entry)).toContain(String(ok.headers['x-row-count']));
  });
});
