// Task 6.2: supplier payments in the 4.6 customer money report (plan docs/plans/6.2-supplier-payments.md, section 6 and
// plan review points 2 and 5): paid in the trip currency leaves the money to keep, a prepayment is a row, other
// currencies are listed and never netted, costs with no trip are reported apart, and the paid columns match the ledger.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClientMoneyService } from '../../../src/modules/payments/core/client-money.service';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { CATALOGUE_AND_PRICING, closeCatalogue } from '../../support/catalogue';
import {
  ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, sim, simulatorAccount,
} from '../../support/payments';
import { pricedWorld } from '../../support/pricing';
import { ALL_SUPPLIER_PERMISSIONS, adminWith, must, setSuppliersFlag, supplierBody } from '../../support/suppliers';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
type Row = { packageId: string; currency: string; bookings: number; costsNote: string; otherCurrencyPaid: Array<{ currency: string; amountMinor: string }>; money: Record<string, string | boolean | null> };
const report = async () => must(await admin.get('/admin/payments/reports/client-money'), 'report').body as { rows: Row[]; unlinked: Array<{ currency: string; costMinor: string; paidMinor: string; unpaidMinor: string }>; totals: Array<Record<string, string>> };

async function supplier(currency = 'AUD') {
  return must(await admin.post('/admin/suppliers', supplierBody({ name: `Hotel ${randomUUID().slice(0, 6)}`, countryCode: 'AU', defaultCurrency: currency })), 'supplier').body as { id: string };
}
async function cost(supplierId: string, packageId: string | null, unitAmountMinor: string, currency = 'AUD') {
  return must(await admin.post(`/admin/suppliers/${supplierId}/costs`, { description: 'Rooms', basis: 'fixed', quantity: 1, unitAmountMinor, currency, packageId }), 'cost').body as { id: string; version: number };
}
const pay = async (supplierId: string, costs: Array<{ id: string; version: number }>) =>
  must(await admin.post(`/admin/suppliers/${supplierId}/payments`, { items: costs.map((x) => ({ costItemId: x.id, version: x.version })), paidOn: today(), reference: 'INV-9' }).set('Idempotency-Key', `k-${randomUUID()}`), 'pay').body as { id: string; version: number };

async function paidTrip() {
  const w = await pricedWorld(admin);
  const { reference, bookingId } = await approvedBooking(t, admin, w, c);
  expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId } }))[0]!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  await deliver(t, acc, await eventFor(t, acc, p.id));
  return { w, held: p.amountMinor };
}

describe('the report with supplier payments', () => {
  it('report_subtracts_supplier_payments_from_money_to_keep; voided_supplier_payment_not_counted', async () => {
    const { w, held } = await paidTrip();
    const s = await supplier();
    const k = await cost(s.id, w.pkg.id, '30000');
    let row = (await report()).rows.find((r) => r.packageId === w.pkg.id)!;
    expect(row.money).toMatchObject({ heldMinor: held.toString(), owedToSuppliersMinor: '30000', keepSeparateMinor: held.toString(), paidToSuppliersMinor: '0', paidBeyondCustomerMoneyMinor: '0' });
    const p = await pay(s.id, [k]);
    row = (await report()).rows.find((r) => r.packageId === w.pkg.id)!;
    expect(row.money).toMatchObject({ owedToSuppliersMinor: '0', marginNotEarnedMinor: (held - 30_000n).toString(), keepSeparateMinor: (held - 30_000n).toString(), paidToSuppliersMinor: '30000', paidBeyondCustomerMoneyMinor: '0' });
    must(await admin.post(`/admin/suppliers/payments/${p.id}/void`, { version: p.version, reason: 'Mistake' }).set('Idempotency-Key', `k-${randomUUID()}`), 'void');
    row = (await report()).rows.find((r) => r.packageId === w.pkg.id)!;
    expect(row.money).toMatchObject({ owedToSuppliersMinor: '30000', keepSeparateMinor: held.toString(), paidToSuppliersMinor: '0' });
  });

  it('prepayment_before_any_customer_money: the trip is a row, all of it paid from the business\'s own money', async () => {
    const w = await pricedWorld(admin);
    const s = await supplier();
    await pay(s.id, [await cost(s.id, w.pkg.id, '5000')]);
    const row = (await report()).rows.find((r) => r.packageId === w.pkg.id)!;
    expect(row.bookings).toBe(0);
    expect(row.money).toMatchObject({ heldMinor: '0', paidToSuppliersMinor: '5000', paidBeyondCustomerMoneyMinor: '5000', keepSeparateMinor: '0', owedToSuppliersMinor: '0', tripTravelled: false });
  });

  it('other_currency_supplier_payments_listed_not_netted; unlinked_supplier_costs_reported_apart', async () => {
    const { w, held } = await paidTrip();
    const eur = await supplier('EUR');
    await pay(eur.id, [await cost(eur.id, w.pkg.id, '12000', 'EUR')]);
    const row = (await report()).rows.find((r) => r.packageId === w.pkg.id)!;
    expect(row.costsNote).toBe('costs_in_other_currency');
    expect(row.otherCurrencyPaid).toEqual([{ currency: 'EUR', amountMinor: '12000' }]);
    // Nothing in another currency is subtracted from what must be kept aside (no conversion).
    expect(row.money).toMatchObject({ keepSeparateMinor: held.toString(), paidToSuppliersMinor: '0', owedToSuppliersMinor: null });
    const nzd = await supplier('NZD');
    const before = (await report()).unlinked.find((u) => u.currency === 'NZD') ?? { costMinor: '0', paidMinor: '0', unpaidMinor: '0' };
    const a = await cost(nzd.id, null, '800', 'NZD');
    await cost(nzd.id, null, '300', 'NZD');
    await pay(nzd.id, [a]);
    const after = (await report()).unlinked.find((u) => u.currency === 'NZD')!;
    expect([BigInt(after.costMinor) - BigInt(before.costMinor), BigInt(after.paidMinor) - BigInt(before.paidMinor), BigInt(after.unpaidMinor) - BigInt(before.unpaidMinor)]).toEqual([1100n, 800n, 300n]);
  });

  it('test_mode_supplier_payment_not_counted_in_production', async () => {
    const w = await pricedWorld(admin);
    const s = await supplier();
    await pay(s.id, [await cost(s.id, w.pkg.id, '4000')]);
    const gw = t.app.get(ProviderGateway);
    const spy = vi.spyOn(gw, 'mode', 'get').mockReturnValue('live');
    try {
      const live = await t.app.get(ClientMoneyService).report();
      expect(live.rows.find((r) => r.packageId === w.pkg.id)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('supplier_paid_totals_match_ledger: per currency, every paid column of the report is the supplier_payable balance', async () => {
    // A prepayment, a trip payment, a voided one, a cost with no trip and one in another currency, all at once.
    const w = await pricedWorld(admin);
    const s = await supplier();
    await pay(s.id, [await cost(s.id, w.pkg.id, '2500')]);
    const v = await pay(s.id, [await cost(s.id, w.pkg.id, '700')]);
    must(await admin.post(`/admin/suppliers/payments/${v.id}/void`, { version: v.version, reason: 'Mistake' }).set('Idempotency-Key', `k-${randomUUID()}`), 'void');
    await pay(s.id, [await cost(s.id, null, '900')]);
    const r = await report();
    const fromReport = new Map<string, bigint>();
    const add = (cur: string, v: bigint) => fromReport.set(cur, (fromReport.get(cur) ?? 0n) + v);
    for (const row of r.rows) {
      add(row.currency, BigInt(row.money.paidToSuppliersMinor as string));
      for (const o of row.otherCurrencyPaid) add(o.currency, BigInt(o.amountMinor));
    }
    for (const u of r.unlinked) add(u.currency, BigInt(u.paidMinor));
    const ledger = await t.prisma.$queryRaw<Array<{ currency: string; total: bigint }>>`
      SELECT currency, SUM("amountMinor")::bigint AS total FROM ledger_entries WHERE "accountCode" = 'supplier_payable' AND mode = 'test' GROUP BY currency`;
    for (const l of ledger) expect([l.currency, fromReport.get(l.currency) ?? 0n]).toEqual([l.currency, l.total]);
    for (const [cur, v2] of fromReport) if (v2 !== 0n) expect(ledger.find((l) => l.currency === cur)?.total).toBe(v2);
  });
});
