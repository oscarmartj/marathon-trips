// Routing rules, gateway health and fallback through the API and the database (task 4.2, plan
// docs/plans/4.2-routing-rules.md, sections 10 and 15). Simulator accounts only; failure paths first.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountsService } from '../../../src/modules/payments/core/accounts.service';
import { ProviderHealthService } from '../../../src/modules/payments/core/provider-health.service';
import { AUTH_FAILED_OPEN_UNTIL } from '../../../src/modules/payments/core/routing-rules';
import { PAYMENTS_PERMISSIONS } from '../../../src/modules/payments/manifest';
import { TestApp, makeApp } from '../../support/auth';
import { CATALOGUE_AND_PRICING, Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import {
  ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, approvedBooking, cleanPayments, onlyAccount, payingCustomer, paymentsStaff, resetGatewayHealth, sim, simulatorAccount,
} from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
let c: PayingCustomer;
const RULES = '/admin/payments/routing-rules';

beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  c = await payingCustomer(t);
});
beforeEach(async () => {
  await resetGatewayHealth(t);
});
afterAll(async () => {
  await resetGatewayHealth(t);
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

// A world of its own per booking (as flow.test.ts): bookings here would otherwise run out of places.
const fresh = async () => approvedBooking(t, admin, await pricedWorld(admin), c);
const paymentsOf = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
const rulesOf = (accountId: string) => t.prisma.routingRule.findMany({ where: { providerAccountId: accountId }, orderBy: { method: 'asc' } });
const cardRule = async (accountId: string) => (await rulesOf(accountId)).find((r) => r.method === 'card')!;
const health = (accountId: string) => t.prisma.providerAccountHealth.findUnique({ where: { providerAccountId: accountId } });

/** Only these new simulator accounts take payments (every other active account is paused, as other files do). */
async function accounts(n: number): Promise<SimAccount[]> {
  await onlyAccount(t, null);
  const out: SimAccount[] = [];
  for (let i = 0; i < n; i++) out.push(await simulatorAccount(t));
  return out;
}

/** Makes `n` bookings fail on `acc` (the simulator answers unavailable): their attempts stay live on it, as in 3.1. */
async function outage(acc: SimAccount, n = 3): Promise<Array<{ reference: string; bookingId: string }>> {
  const stuck: Array<{ reference: string; bookingId: string }> = [];
  for (let i = 0; i < n; i++) {
    const b = await fresh();
    sim.queue(acc.id, 'unavailable');
    const r = await c.pay(b.reference, { method: 'card' });
    expect(r.status).toBe(503);
    stuck.push(b);
  }
  return stuck;
}

const setPriority = (ruleId: string, priority: number) => t.prisma.routingRule.update({ where: { id: ruleId }, data: { priority } });

describe('gateway_down_checkout_offers_others (phase 4 criterion)', () => {
  it('with A unreachable, a new booking is offered card and pays through B; A is not called', async () => {
    const [A, B] = await accounts(2);
    await setPriority((await cardRule(A!.id)).id, 10);
    await setPriority((await cardRule(B!.id)).id, 20);
    await outage(A!);
    expect((await health(A!.id))!.openUntil!.getTime()).toBeGreaterThan(Date.now());
    const callsA = sim.createCalls(A!.id);
    const b = await fresh();
    const plan = await c.plan(b.reference);
    expect(plan.status).toBe(200);
    expect(plan.body.methods).toContain('card');
    expect(plan.body.payable).toBe(true);
    const r = await c.pay(b.reference, { method: 'card' });
    expect(r.status).toBe(201);
    expect(r.body.nextAction?.type).toBe('redirect');
    const [p] = await paymentsOf(b.bookingId);
    expect(p!.providerAccountId).toBe(B!.id);
    expect(sim.createCalls(A!.id)).toBe(callsA);
  });

  it('the same with B as the backup of A: the backup serves, and the audit says so', async () => {
    const [A, B] = await accounts(2);
    const primary = await cardRule(A!.id);
    await t.prisma.routingRule.update({ where: { id: (await cardRule(B!.id)).id }, data: { fallbackForRuleId: primary.id } });
    const b0 = await fresh();
    expect((await c.pay(b0.reference, { method: 'card' })).status).toBe(201);
    expect((await paymentsOf(b0.bookingId))[0]!.providerAccountId).toBe(A!.id);
    await outage(A!);
    const b = await fresh();
    expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
    const [p] = await paymentsOf(b.bookingId);
    expect(p!.providerAccountId).toBe(B!.id);
    const audit = await t.prisma.auditLog.findFirst({ where: { action: 'payments.payment.created', entityId: p!.id } });
    expect(JSON.stringify(audit!.changes)).toContain(primary.id);
  });

  it('with nothing left to serve, the plan view is 200 with no_payment_method_available, never a 5xx', async () => {
    const [A] = await accounts(1);
    await outage(A!);
    const b = await fresh();
    const plan = await c.plan(b.reference);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ payable: false, notPayableReason: 'no_payment_method_available' });
    const r = await c.pay(b.reference, { method: 'card' });
    expect([r.status, r.body.code]).toEqual([409, 'no_payment_method_available']);
  });
});

describe('fallback never charges twice (plan section 4)', () => {
  it('outage_never_moves_a_live_attempt and outage_customer_keeps_booking_plan_view_200', async () => {
    const [A, B] = await accounts(2);
    await setPriority((await cardRule(B!.id)).id, 200);
    const b = await fresh();
    const key = randomUUID();
    sim.queue(A!.id, 'unavailable');
    expect((await c.pay(b.reference, { method: 'card' }, key)).status).toBe(503);
    await outage(A!, 2);
    // Same HTTP key: the same attempt, on A, with the same gateway key.
    sim.queue(A!.id, 'unavailable');
    const again = await c.pay(b.reference, { method: 'card' }, key);
    expect(again.status).toBe(503);
    const ps = await paymentsOf(b.bookingId);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.providerAccountId).toBe(A!.id);
    const plan = await c.plan(b.reference);
    expect(plan.status).toBe(200);
    expect(plan.body.liveAttempt).not.toBeNull();
    // Staff see the stuck bookings.
    const warn = await admin.get('/admin/payments/routing/warnings');
    const stuck = (warn.body.items as Array<{ code: string; accountId?: string; bookingIds?: string[] }>).find((x) => x.code === 'live_attempts_on_unreachable_account' && x.accountId === A!.id);
    expect(stuck!.bookingIds).toContain(b.bookingId);
    expect((warn.body.items as Array<{ code: string; accountId?: string }>).some((x) => x.code === 'account_unreachable' && x.accountId === A!.id)).toBe(true);
    // Asking to replace it while A is down: the attempt is resumed on its own account (same gateway key), never moved.
    sim.queue(A!.id, 'unavailable');
    const replace = await c.pay(b.reference, { method: 'card', replaceLiveAttempt: true });
    expect(replace.status).toBe(503);
    // Another key while A is still down: the same attempt on A (resumed, same gateway key), never one on B.
    sim.queue(A!.id, 'unavailable');
    const other = await c.pay(b.reference, { method: 'card' });
    expect(other.status).toBe(503);
    const after = await paymentsOf(b.bookingId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(ps[0]!.id);
    expect(sim.find(B!.id, { paymentId: ps[0]!.id })).toBeNull();
    // A recovers: the retry with the same key resumes on A.
    await resetGatewayHealth(t);
    const resumed = await c.pay(b.reference, { method: 'card' }, key);
    expect(resumed.status).toBe(201);
    expect(await paymentsOf(b.bookingId)).toHaveLength(1);
  });

  it('resume_ignores_rule_changes_but_requires_active_account', async () => {
    const [A, B] = await accounts(2);
    const b = await fresh();
    expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
    await t.prisma.routingRule.updateMany({ where: { providerAccountId: A!.id }, data: { enabled: false } });
    const resumed = await c.pay(b.reference, { method: 'card' });
    expect(resumed.status).toBe(201);
    const ps = await paymentsOf(b.bookingId);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.providerAccountId).toBe(A!.id);
    // A paused: not resumed (4.1 behaviour), and nothing new on B while it lives.
    await t.prisma.providerAccount.update({ where: { id: A!.id }, data: { status: 'paused' } });
    const r = await c.pay(b.reference, { method: 'card' });
    expect([r.status, r.body.code]).toEqual([409, 'payment_attempt_in_progress']);
    expect(sim.createCalls(B!.id)).toBe(0);
  });
});

describe('breaker (plan 3 and 15.2 to 15.6)', () => {
  it('half_open_admits_single_probe: a held probe sends payments to the backup; a failed probe reopens at once; a successful one closes', async () => {
    const [A, B] = await accounts(2);
    await setPriority((await cardRule(B!.id)).id, 200);
    await outage(A!);
    const past = new Date(Date.now() - 1000);
    // Past the cooldown with the probe held by another attempt: B.
    await t.prisma.providerAccountHealth.update({ where: { providerAccountId: A!.id }, data: { openUntil: past, probeUntil: new Date(Date.now() + 60_000) } });
    const held = await fresh();
    expect((await c.pay(held.reference, { method: 'card' })).status).toBe(201);
    expect((await paymentsOf(held.bookingId))[0]!.providerAccountId).toBe(B!.id);
    // The probe free: one attempt takes A and fails; the breaker reopens at once and the next goes to B.
    await t.prisma.providerAccountHealth.update({ where: { providerAccountId: A!.id }, data: { openUntil: past, probeUntil: null } });
    const probe = await fresh();
    sim.queue(A!.id, 'timeout');
    expect((await c.pay(probe.reference, { method: 'card' })).status).toBe(503);
    expect((await paymentsOf(probe.bookingId))[0]!.providerAccountId).toBe(A!.id);
    const h = (await health(A!.id))!;
    expect(h.openUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(h.probeUntil).toBeNull();
    const next = await fresh();
    expect((await c.pay(next.reference, { method: 'card' })).status).toBe(201);
    expect((await paymentsOf(next.bookingId))[0]!.providerAccountId).toBe(B!.id);
    // A probe that succeeds closes it.
    await t.prisma.providerAccountHealth.update({ where: { providerAccountId: A!.id }, data: { openUntil: past, probeUntil: null } });
    const ok = await fresh();
    expect((await c.pay(ok.reference, { method: 'card' })).status).toBe(201);
    expect((await paymentsOf(ok.bookingId))[0]!.providerAccountId).toBe(A!.id);
    expect(await health(A!.id)).toMatchObject({ openUntil: null, openedAt: null, consecutiveFailures: 0 });
  });

  it('auth_failed_stays_open_until_success; an ok connection test closes it', async () => {
    const [A] = await accounts(1);
    for (let i = 0; i < 3; i++) {
      const b = await fresh();
      // A revoked key: the gateway refuses the create and the lookup by our key alike.
      sim.queue(A!.id, 'auth_failed');
      sim.failNextRetrieve(A!.id, 'auth_failed');
      await c.pay(b.reference, { method: 'card' });
    }
    expect((await health(A!.id))!.openUntil).toEqual(AUTH_FAILED_OPEN_UNTIL);
    const warn = await admin.get('/admin/payments/routing/warnings');
    expect((warn.body.items as Array<{ code: string; accountId?: string }>).some((x) => x.code === 'account_auth_failed' && x.accountId === A!.id)).toBe(true);
    const test = await admin.post(`/admin/payments/provider-accounts/${A!.id}/connection-test`, {});
    expect(test.status).toBe(200);
    expect((await health(A!.id))!.openUntil).toBeNull();
  });

  it('breaker_counts_auth_failed_not_rejected', async () => {
    const [A] = await accounts(1);
    for (let i = 0; i < 4; i++) {
      const b = await fresh();
      sim.queue(A!.id, 'rejected');
      await c.pay(b.reference, { method: 'card' });
    }
    const h = await health(A!.id);
    expect(h?.openUntil ?? null).toBeNull();
    expect(h?.consecutiveFailures ?? 0).toBe(0);
  });

  it('breaker_opens_once_under_concurrent_failures', async () => {
    const [A] = await accounts(1);
    const svc = t.app.get(ProviderHealthService);
    await Promise.all(Array.from({ length: 6 }, () => svc.failure(A!.id, 'provider_unavailable')));
    expect((await health(A!.id))!.consecutiveFailures).toBe(6);
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.providerAccount.unreachable', entityId: A!.id } })).toBe(1);
  });

  it('health_write_failure_keeps_gateway_result', async () => {
    const [A] = await accounts(1);
    const svc = t.app.get(ProviderHealthService) as unknown as { lockRow: () => Promise<never> };
    const spy = vi.spyOn(svc, 'lockRow').mockRejectedValue(Object.assign(new Error('boom'), { code: 'P0001' }));
    try {
      const b = await fresh();
      sim.queue(A!.id, 'unavailable');
      expect((await c.pay(b.reference, { method: 'card' })).status).toBe(503);
    } finally {
      spy.mockRestore();
    }
  });

  it('breaker_does_not_change_account_status_or_coverage', async () => {
    const [A] = await accounts(1);
    await outage(A!);
    expect((await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: A!.id } })).status).toBe('active');
    const warn = await admin.get('/admin/payments/provider-accounts/warnings');
    expect((warn.body.items as Array<{ code: string }>).some((x) => x.code === 'no_method_for_country')).toBe(false);
    const rw = await admin.get('/admin/payments/routing/warnings');
    expect((rw.body.items as Array<{ code: string; method?: string }>).some((x) => x.code === 'method_unreachable_now' && x.method === 'card')).toBe(true);
  });

  it('candidate_tests_do_not_touch_health: creating accounts from the panel and the console writes no health', async () => {
    await onlyAccount(t, null);
    const made = await admin.post('/admin/payments/provider-accounts', { adapterKey: 'simulator', displayName: `Sim ${randomUUID().slice(0, 6)}`, mode: 'test' });
    expect(made.status).toBe(201);
    const manual = await t.app.get(ProviderAccountsService).createManualAccount({ displayName: 'Transfers (routing test)' });
    expect(await health(made.body.id)).toBeNull();
    expect(await health(manual.id)).toBeNull();
    await t.prisma.providerAccount.update({ where: { id: manual.id }, data: { status: 'paused' } });
  });
});

describe('routing rules in the panel (plan section 8)', () => {
  it('routing_rule_requires_permission_and_step_up', async () => {
    const [A] = await accounts(1);
    const reader = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, PAYMENTS_PERMISSIONS.accountRead]);
    expect((await reader.get(RULES)).status).toBe(200);
    const body = { providerAccountId: A!.id, method: 'card', countries: ['AU'], currency: 'AUD', priority: 5, enabled: true };
    expect((await reader.post(RULES, body)).status).toBe(403);
    const stale = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
    await t.prisma.session.updateMany({ where: { userId: stale.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const r = await stale.post(RULES, body);
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    const ok = await admin.post(RULES, body);
    expect(ok.status).toBe(201);
    const audit = await t.prisma.auditLog.findFirst({ where: { action: 'payments.routingRule.created', entityId: ok.body.id } });
    expect(audit).not.toBeNull();
  });

  it('routing_rule_validation_table', async () => {
    const [A, B] = await accounts(2);
    const primary = await cardRule(A!.id);
    const base = { providerAccountId: B!.id, method: 'card', countries: null, currency: 'AUD', priority: 10, enabled: true };
    const bad: Array<[Record<string, unknown>, number, string]> = [
      [{ method: 'payto' }, 422, 'rule_method_not_supported'],
      [{ currency: 'NZD' }, 422, 'rule_currency_not_supported'],
      [{ currency: 'aud' }, 422, 'rule_currency_not_supported'],
      [{ countries: [] }, 422, 'rule_countries_invalid'],
      [{ countries: ['au'] }, 422, 'rule_countries_invalid'],
      [{ countries: ['AU', 'AU'] }, 422, 'rule_countries_invalid'],
      [{ minAmountMinor: '1.5' }, 422, 'rule_amount_invalid'],
      [{ minAmountMinor: '-1' }, 422, 'rule_amount_invalid'],
      [{ maxAmountMinor: '1e3' }, 422, 'rule_amount_invalid'],
      [{ maxAmountMinor: '0' }, 422, 'rule_amount_invalid'],
      [{ maxAmountMinor: '1000000000001' }, 422, 'rule_amount_invalid'],
      [{ minAmountMinor: '500', maxAmountMinor: '400' }, 422, 'rule_limits_inverted'],
      [{ priority: 1001 }, 422, 'rule_priority_invalid'],
      [{ priority: -1 }, 422, 'rule_priority_invalid'],
      [{ fallbackForRuleId: randomUUID() }, 422, 'fallback_target_missing'],
      [{ fallbackForRuleId: primary.id, method: 'apple_pay' }, 422, 'fallback_mismatch'],
      [{ fallbackForRuleId: primary.id, providerAccountId: A!.id }, 422, 'fallback_same_account'],
    ];
    for (const [over, status, code] of bad) {
      const r = await admin.post(RULES, { ...base, ...over });
      expect([r.status, r.body.code], JSON.stringify(over)).toEqual([status, code]);
    }
    const backup = await admin.post(RULES, { ...base, fallbackForRuleId: primary.id });
    expect(backup.status).toBe(201);
    const chain = await admin.post(RULES, { ...base, providerAccountId: A!.id, fallbackForRuleId: backup.body.id });
    expect([chain.status, chain.body.code]).toEqual([422, 'fallback_target_is_fallback']);
    const asBackup = await admin.patch(`${RULES}/${primary.id}`, { version: primary.version, fallbackForRuleId: (await cardRule(B!.id)).id });
    expect([asBackup.status, asBackup.body.code]).toEqual([422, 'rule_is_fallback_target']);
    const del = await admin.post(`${RULES}/${primary.id}/delete`, { version: primary.version });
    expect([del.status, del.body.code]).toEqual([409, 'rule_has_fallbacks']);
    const stale = await admin.patch(`${RULES}/${backup.body.id}`, { version: 7, priority: 3 });
    expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
    await t.prisma.providerAccount.update({ where: { id: A!.id }, data: { status: 'retired' } });
    const retired = await admin.post(RULES, { ...base, providerAccountId: A!.id });
    expect([retired.status, retired.body.code]).toEqual([409, 'account_not_accepting_charges']);
  });

  it('routing_rule_trigger_nets: the database refuses what the service refuses', async () => {
    const [A, B] = await accounts(2);
    const pa = await cardRule(A!.id);
    const pb = await cardRule(B!.id);
    const raw = (sql: string, ...args: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...args);
    await expect(raw(`UPDATE payment_routing_rules SET "fallbackForRuleId" = id WHERE id = $1::uuid`, pa.id)).rejects.toThrow();
    await expect(raw(`UPDATE payment_routing_rules SET "providerAccountId" = $2::uuid WHERE id = $1::uuid`, pa.id, B!.id)).rejects.toThrow(/never changes/);
    const apple = (await rulesOf(B!.id)).find((r) => r.method === 'apple_pay')!;
    await expect(raw(`UPDATE payment_routing_rules SET "fallbackForRuleId" = $2::uuid WHERE id = $1::uuid`, apple.id, pa.id)).rejects.toThrow(/method and currency/);
    const sameAccount = (await rulesOf(A!.id)).find((r) => r.method === 'apple_pay')!;
    await expect(raw(`UPDATE payment_routing_rules SET "fallbackForRuleId" = $2::uuid, method = 'card' WHERE id = $1::uuid`, sameAccount.id, pa.id)).rejects.toThrow(/another account/);
    await raw(`UPDATE payment_routing_rules SET "fallbackForRuleId" = $2::uuid WHERE id = $1::uuid`, pb.id, pa.id);
    await expect(raw(`UPDATE payment_routing_rules SET "fallbackForRuleId" = $2::uuid WHERE id = $1::uuid`, pa.id, pb.id)).rejects.toThrow();
    await expect(raw(`UPDATE payment_routing_rules SET method = 'apple_pay' WHERE id = $1::uuid`, pa.id)).rejects.toThrow(/keeps its method/);
    await expect(raw(`DELETE FROM payment_routing_rules WHERE id = $1::uuid`, pa.id)).rejects.toThrow();
    for (const bad of [`countries = ARRAY['au']`, `countries = ARRAY['AU','AU'], "anyCountry" = false`, `"anyCountry" = false`, `"minAmountMinor" = -1`, `"maxAmountMinor" = 0`, `"minAmountMinor" = 5, "maxAmountMinor" = 4`, `priority = 1001`, `currency = 'au1'`]) {
      await expect(raw(`UPDATE payment_routing_rules SET ${bad} WHERE id = $1::uuid`, apple.id), bad).rejects.toThrow();
    }
    await expect(raw(`DELETE FROM provider_account_health`)).rejects.toThrow();
  });

  it('rule_change_losing_coverage_needs_confirmation, and a backup keeps coverage when the primary is paused', async () => {
    const [A, B] = await accounts(2);
    const rule = await cardRule(A!.id);
    // B's card rule removed (B still has apple and google): A's card rule is the last for card.
    const bCard = await cardRule(B!.id);
    expect((await admin.post(`${RULES}/${bCard.id}/delete`, { version: bCard.version })).status).toBe(200);
    const off = await admin.patch(`${RULES}/${rule.id}`, { version: rule.version, enabled: false });
    expect([off.status, off.body.code]).toEqual([409, 'coverage_loss_unconfirmed']);
    expect(off.body.details?.lost ?? off.body.lost).toBeDefined();
    const narrow = await admin.patch(`${RULES}/${rule.id}`, { version: rule.version, countries: ['NZ'] });
    expect([narrow.status, narrow.body.code]).toEqual([409, 'coverage_loss_unconfirmed']);
    const del = await admin.post(`${RULES}/${rule.id}/delete`, { version: rule.version });
    expect([del.status, del.body.code]).toEqual([409, 'coverage_loss_unconfirmed']);
    expect(await t.prisma.routingRule.count({ where: { id: rule.id } })).toBe(1);
    // A backup on B: pausing A loses nothing.
    const backup = await admin.post(RULES, { providerAccountId: B!.id, method: 'card', countries: null, currency: 'AUD', priority: 100, enabled: true, fallbackForRuleId: rule.id });
    expect(backup.status).toBe(201);
    const acc = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: A!.id } });
    const pause = await admin.post(`/admin/payments/provider-accounts/${A!.id}/status`, { version: acc.version, status: 'paused' });
    expect(pause.status).toBe(200);
    expect(pause.body.lost.filter((l: { method: string }) => l.method === 'card')).toEqual([]);
    // Disabling a primary with a backup: allowed, and the answer says which backup serves.
    await t.prisma.providerAccount.update({ where: { id: A!.id }, data: { status: 'active', pauseReasonCode: null } });
    const r2 = await t.prisma.routingRule.findUniqueOrThrow({ where: { id: rule.id } });
    const disable = await admin.patch(`${RULES}/${rule.id}`, { version: r2.version, enabled: false });
    expect(disable.status).toBe(200);
    expect(disable.body.backupsServing).toEqual([backup.body.id]);
  });

  it('concurrent_rule_deletes_warn_once', async () => {
    const [A, B] = await accounts(2);
    const ra = await cardRule(A!.id);
    const rb = await cardRule(B!.id);
    const [x, y] = await Promise.all([
      admin.post(`${RULES}/${ra.id}/delete`, { version: ra.version }),
      admin.post(`${RULES}/${rb.id}/delete`, { version: rb.version }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.code).toBe('coverage_loss_unconfirmed');
  });

  it('default_rules_created_with_account (no bnpl) and restore_default_rules_adds_only_missing', async () => {
    const [A] = await accounts(1);
    const rules = await rulesOf(A!.id);
    expect(rules.map((r) => r.method).sort()).toEqual(['apple_pay', 'card', 'google_pay']);
    const acc = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: A!.id } });
    expect(rules.every((r) => r.createdAt.getTime() === acc.createdAt.getTime() && r.anyCountry && r.priority === 100 && r.currency === 'AUD')).toBe(true);
    const apple = rules.find((r) => r.method === 'apple_pay')!;
    expect((await admin.post(`${RULES}/${apple.id}/delete`, { version: apple.version, confirmCoverageLoss: true })).status).toBe(200);
    const restored = await admin.post(`/admin/payments/provider-accounts/${A!.id}/routing-rules/defaults`, {});
    expect([restored.status, restored.body.added]).toEqual([200, 1]);
    expect((await admin.post(`/admin/payments/provider-accounts/${A!.id}/routing-rules/defaults`, {})).body.added).toBe(0);
    expect((await rulesOf(A!.id)).map((r) => r.method).sort()).toEqual(['apple_pay', 'card', 'google_pay']);
  });

  it('limits_use_server_amount and method_limited_by_amount_warns', async () => {
    const [A] = await accounts(1);
    const b = await fresh();
    const due = BigInt((await c.plan(b.reference)).body.nextPayable.amountMinor);
    const rule = await cardRule(A!.id);
    const capped = await admin.patch(`${RULES}/${rule.id}`, { version: rule.version, maxAmountMinor: (due - 1n).toString() });
    expect(capped.status).toBe(200);
    const plan = await c.plan(b.reference);
    expect(plan.body.methods).not.toContain('card');
    const r = await c.pay(b.reference, { method: 'card' });
    expect([r.status, r.body.code]).toEqual([409, 'no_payment_method_available']);
    // The body never carries an amount (strict schema).
    expect((await c.pay(b.reference, { method: 'card', amountMinor: '1' })).status).toBe(422);
    const warn = await admin.get('/admin/payments/routing/warnings');
    const gap = (warn.body.items as Array<{ code: string; method?: string; gaps?: Array<{ fromMinor: string }> }>).find((x) => x.code === 'method_limited_by_amount' && x.method === 'card');
    expect(gap!.gaps![0]!.fromMinor).toBe(due.toString());
    const preview = await admin.get(`/admin/payments/routing/preview?method=card&country=AU&currency=AUD&amountMinor=${due}`);
    expect(preview.status).toBe(200);
    expect(preview.body.route).toEqual([]);
    expect((preview.body.reasons as Array<{ ruleId: string; reason: string }>).find((x) => x.ruleId === rule.id)!.reason).toBe('above_max');
  });
});

describe('adapter states (plan section 7)', () => {
  it('planned_entries_listed_not_creatable', async () => {
    const list = await admin.get('/admin/payments/adapters');
    const paypal = (list.body.items as Array<{ key: string; status: string; creatable: boolean }>).find((a) => a.key === 'paypal');
    expect(paypal).toMatchObject({ status: 'planned', creatable: false });
    const r = await admin.post('/admin/payments/provider-accounts', { adapterKey: 'paypal', displayName: 'PayPal', mode: 'test' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await t.prisma.providerAccount.count({ where: { adapterKey: 'paypal' } })).toBe(0);
  });
});
