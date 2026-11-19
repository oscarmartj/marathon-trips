// Gateway accounts in the panel, through the API and the database (task 4.1, plan
// docs/plans/4.1-provider-accounts-panel.md, sections 7 and 15). Test mode only: the registry's Stripe adapter is swapped
// for one with the fake Stripe's transport for this file, so nothing reaches Stripe. Failure paths first.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StripeProvider } from '../../../src/modules/payments/adapters/stripe/stripe';
import { signStripe } from '../../../src/modules/payments/adapters/stripe/mapping';
import type { StripeTransport } from '../../../src/modules/payments/adapters/stripe/stripe';
import { PaymentAdapterRegistry } from '../../../src/modules/payments/core/registry';
import type { AdapterManifest, PaymentProvider } from '../../../src/modules/payments/core/provider';
import { ProviderGateway, webhookSecretAad } from '../../../src/modules/payments/core/gateway';
import { PaymentRouting } from '../../../src/modules/payments/core/routing';
import { ProviderAccountsBootCheck } from '../../../src/modules/payments/core/account-admin.service';
import { CollectionCoverageGuard } from '../../../src/modules/payments/core/coverage-guard';
import { INTEGRATIONS_PERMISSIONS as IP } from '../../../src/platform/integrations/permissions';
import { CATALOGUE_PERMISSIONS } from '../../../src/modules/catalogue/manifest';
import { ProviderAccountsService } from '../../../src/modules/payments/core/accounts.service';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { TasksService } from '../../../src/platform/common/tasks/tasks.service';
import { SettingsService } from '../../../src/platform/flags/flags.service';
import { STATE_HEADERS, TestApp, createStaff, makeApp, signInStaff } from '../../support/auth';
import { CATALOGUE_AND_PRICING, Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import { ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, sendWebhook, sim } from '../../support/payments';
import { FakeStripe } from '../../contract/subjects/stripe-fake';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof staffClient>>;
let c: PayingCustomer;
const fake = new FakeStripe();
let stripeCalls = 0;
/** A connection test held inside the transport until released (plan 4.1, 15.4): it then answers 401. */
let hold: { reached: () => void; release: Promise<void> } | null = null;
const transport: StripeTransport = async (req) => {
  stripeCalls++;
  if (hold && req.method === 'GET' && req.path === '/v1/checkout/sessions') {
    const h = hold;
    hold = null;
    h.reached();
    await h.release;
    return fake.transport({ ...req, headers: { ...req.headers, authorization: `Bearer sk_test_${'0'.repeat(24)}` } });
  }
  return fake.transport(req);
};
let registered: PaymentProvider | undefined;
const byKey = () => (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;

const PERMS = [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS];
const freshAdmin = () => staffClient(t, PERMS);
const whsec = () => `whsec_${randomBytes(24).toString('hex')}`;
const name = (p = 'Account') => `${p} ${randomUUID().slice(0, 8)}`;
const ACCOUNTS = '/admin/payments/provider-accounts';

/** A Stripe-shaped event signed with `secret` (for deliveries the account must refuse). */
function stripeEvent(secret: string) {
  const eventId = `evt_${randomBytes(8).toString('hex')}`;
  const body = Buffer.from(JSON.stringify({ id: eventId, object: 'event', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: 'cs_test_none', object: 'checkout.session' } } }));
  return { body, eventId, headers: { 'content-type': 'application/json', 'stripe-signature': signStripe(secret, body, new Date()) } };
}

async function view(who: Client, id: string) {
  const list = await who.get(ACCOUNTS);
  expect(list.status).toBe(200);
  return (list.body.items as Array<Record<string, unknown> & { id: string; version: number; status: string }>).find((a) => a.id === id)!;
}

async function panelSim(who: Client = admin) {
  const r = await who.post(ACCOUNTS, { adapterKey: 'simulator', displayName: name('Sim'), mode: 'test' });
  expect([r.status, r.body.connectionTest]).toEqual([201, 'ok']);
  return r.body as { id: string; webhookUrl: string; connectionTest: string };
}

/** The account as a SimAccount for the webhook helpers: its secret is read back for the test only. */
async function asSim(id: string, webhookUrl: string): Promise<SimAccount> {
  const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } });
  return { id, pathToken: webhookUrl.split('/').pop()!, secret: t.box.decrypt(row.webhookSecretCiphertext!, row.webhookKeyVersion!, webhookSecretAad(id)) };
}

async function setStatus(who: Client, id: string, status: string, extra: Record<string, unknown> = {}) {
  return who.post(`${ACCOUNTS}/${id}/status`, { version: (await view(who, id)).version, status, ...extra });
}

async function asOwner<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

beforeAll(async () => {
  t = await makeApp();
  registered = byKey().get('stripe');
  byKey().set('stripe', new StripeProvider({ transport, now: () => fake.now() }));
  admin = await freshAdmin();
  c = await payingCustomer(t);
});
afterAll(async () => {
  if (registered) byKey().set('stripe', registered);
  await t.prisma.providerAccount.updateMany({ where: { status: 'active', displayName: { startsWith: 'Sim ' } }, data: { status: 'paused' } });
  await t.prisma.providerAccount.updateMany({ where: { status: 'active', adapterKey: 'stripe' }, data: { status: 'paused' } });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

describe('creating an account (plan 4.1, 4.1)', () => {
  it('live_account_creation_rejected_while_check_in_place: live is refused first, nothing stored, no gateway call, audited', async () => {
    const before = await t.prisma.providerAccount.count();
    const calls = stripeCalls;
    for (const adapterKey of ['stripe', 'simulator', 'manual']) {
      const r = await admin.post(ACCOUNTS, { adapterKey, displayName: name(), mode: 'live', credentials: { secretKey: `sk_live_${'a'.repeat(24)}` } });
      expect([r.status, r.body.code]).toEqual([409, 'live_mode_not_available']);
      expect(JSON.stringify(r.body)).not.toContain('sk_live_');
    }
    expect(await t.prisma.providerAccount.count()).toBe(before);
    expect(stripeCalls).toBe(calls);
    const refused = await t.prisma.auditLog.findMany({ where: { action: 'payments.providerAccount.creationRefused', actorId: admin.staff.id } });
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(refused)).not.toContain('sk_live_');
    // The database still refuses a live row whatever the API does (0017's CHECK, kept by 4.1).
    const row = await t.prisma.providerAccount.findFirstOrThrow();
    await expect(t.prisma.providerAccount.create({ data: { ...row, id: randomUUID(), mode: 'live', webhookPathTokenHash: randomBytes(32).toString('hex') } })).rejects.toThrow(/test_mode_only/);
  });

  it('credentials_invalid and secret_as_credentials_key_not_echoed: field keys only, an unknown key as (unknown)', async () => {
    const secretAsKey = `sk_test_${'k'.repeat(30)}`;
    const cases: Array<[unknown, string[]]> = [
      [{}, ['secretKey']],
      [{ secretKey: `sk_live_${'a'.repeat(24)}` }, ['secretKey']],
      [{ secretKey: fake.newAccount(), [secretAsKey]: 'x' }, ['(unknown)']],
      ['sk_test_whole_string', ['credentials']],
    ];
    for (const [credentials, fields] of cases) {
      const r = await admin.post(ACCOUNTS, { adapterKey: 'stripe', displayName: name(), mode: 'test', credentials });
      expect([r.status, r.body.code, r.body.fields]).toEqual([422, 'credentials_invalid', fields]);
      expect(JSON.stringify(r.body)).not.toMatch(/sk_(live|test)_/);
    }
    // A key of the request body itself is never repeated either (strict object: the path is the body).
    const extra = await admin.post(ACCOUNTS, { adapterKey: 'stripe', displayName: name(), mode: 'test', [secretAsKey]: 1 });
    expect(extra.status).toBe(422);
    expect(JSON.stringify(extra.body)).not.toContain(secretAsKey);
    const unknown = await admin.post(ACCOUNTS, { adapterKey: 'nope', displayName: name(), mode: 'test' });
    expect([unknown.status, unknown.body.code]).toEqual([422, 'adapter_unknown']);
  });

  it('creation_test_counts_for_activation: born paused, tested at the change time, activated without another test; URL once; no-store', async () => {
    const r = await admin.post(ACCOUNTS, { adapterKey: 'simulator', displayName: name('Sim'), mode: 'test' });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.webhookUrl).toMatch(/\/payments\/webhooks\/[A-Za-z0-9_-]{43}$/);
    const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: r.body.id } });
    expect([row.status, row.pauseReasonCode, row.mode, row.lastConnectionTestResult, row.createdById]).toEqual(['paused', 'staff', 'test', 'ok', admin.staff.id]);
    expect(row.lastConnectionTestAt!.getTime()).toBe(row.credentialsChangedAt.getTime());
    const list = await admin.get(ACCOUNTS);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(list.body)).not.toContain(r.body.webhookUrl.split('/').pop());
    const activated = await setStatus(admin, r.body.id, 'active');
    expect([activated.status, activated.body.status]).toEqual([200, 'active']);
    const after = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: r.body.id } });
    expect([after.status, after.pauseReasonCode]).toEqual(['active', null]);
    await setStatus(admin, r.body.id, 'paused', { confirmCoverageLoss: true });
  });
});

describe('Stripe: key first, webhook secret after the URL is registered (plan 4.1, 15.2)', () => {
  it('created without a webhook secret: webhook_secret_missing blocks activation; setting it allows it; no stale-test warning', async () => {
    const r = await admin.post(ACCOUNTS, { adapterKey: 'stripe', displayName: name('Stripe'), mode: 'test', credentials: { secretKey: fake.newAccount() } });
    expect([r.status, r.body.connectionTest]).toEqual([201, 'webhook_secret_missing']);
    const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: r.body.id } });
    expect([row.webhookSecretCiphertext, row.webhookKeyVersion]).toEqual([null, null]);
    const refused = await setStatus(admin, r.body.id, 'active');
    expect([refused.status, refused.body.code]).toEqual([409, 'connection_test_required']);
    expect((await admin.get(`${ACCOUNTS}/warnings`)).body.items).toContainEqual({ code: 'webhook_secret_missing', accountId: r.body.id });
    // No secret yet: a delivery to its URL is rejected without asking the adapter.
    const pathToken = r.body.webhookUrl.split('/').pop();
    const early = stripeEvent(whsec());
    expect((await sendWebhook(t, { id: r.body.id, pathToken, secret: '' }, early)).status).toBe(400);

    const secret = whsec();
    const bad = await admin.put(`${ACCOUNTS}/${r.body.id}/webhook-secret`, { version: (await view(admin, r.body.id)).version, webhookSecret: 'whsec_' });
    expect([bad.status, bad.body.fields]).toEqual([422, ['webhookSecret']]);
    const set = await admin.put(`${ACCOUNTS}/${r.body.id}/webhook-secret`, { version: (await view(admin, r.body.id)).version, webhookSecret: secret });
    expect([set.status, set.body.connectionTest]).toEqual([200, 'ok']);
    expect(JSON.stringify(set.body)).not.toContain(secret);
    expect((await setStatus(admin, r.body.id, 'active')).status).toBe(200);
    const warnings = (await admin.get(`${ACCOUNTS}/warnings`)).body.items as Array<{ code: string; accountId?: string }>;
    expect(warnings.filter((w) => w.accountId === r.body.id)).toEqual([]);
    await setStatus(admin, r.body.id, 'paused', { confirmCoverageLoss: true });
  });

  it('webhook_secret_typo_flagged_by_warning: a well-formed wrong secret passes the test, the first delivery flags it', async () => {
    const key = fake.newAccount();
    const real = whsec();
    const r = await admin.post(ACCOUNTS, { adapterKey: 'stripe', displayName: name('Stripe'), mode: 'test', credentials: { secretKey: key } });
    const typo = await admin.put(`${ACCOUNTS}/${r.body.id}/webhook-secret`, { version: (await view(admin, r.body.id)).version, webhookSecret: whsec() });
    expect([typo.status, typo.body.connectionTest]).toEqual([200, 'ok']);
    const w = stripeEvent(real);
    expect((await sendWebhook(t, { id: r.body.id, pathToken: r.body.webhookUrl.split('/').pop(), secret: real }, w)).status).toBe(400);
    expect((await admin.get(`${ACCOUNTS}/warnings`)).body.items).toContainEqual({ code: 'webhook_rejected_since_change', accountId: r.body.id });
    const test = await admin.post(`${ACCOUNTS}/${r.body.id}/connection-test`);
    expect(test.body.webhook.lastRejection.reason).toBe('bad_signature');
  });

  it('failed_rotation_keeps_old_credentials and rotation_raises_no_stale_test_warning', async () => {
    const key = fake.newAccount();
    const r = await admin.post(ACCOUNTS, { adapterKey: 'stripe', displayName: name('Stripe'), mode: 'test', credentials: { secretKey: key } });
    await admin.put(`${ACCOUNTS}/${r.body.id}/webhook-secret`, { version: (await view(admin, r.body.id)).version, webhookSecret: whsec() });
    const before = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: r.body.id } });
    const wrong = await admin.put(`${ACCOUNTS}/${r.body.id}/credentials`, { version: before.version, credentials: { secretKey: `sk_test_${'9'.repeat(24)}` } });
    expect([wrong.status, wrong.body.code, wrong.body.connectionTest]).toEqual([422, 'connection_test_failed', 'provider_auth_failed']);
    const same = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: r.body.id } });
    expect([same.credentialsCiphertext, same.version, same.credentialsChangedAt.getTime()]).toEqual([before.credentialsCiphertext, before.version, before.credentialsChangedAt.getTime()]);
    const stale = await admin.put(`${ACCOUNTS}/${r.body.id}/credentials`, { version: before.version - 1, credentials: { secretKey: fake.newAccount() } });
    expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
    const ok = await admin.put(`${ACCOUNTS}/${r.body.id}/credentials`, { version: before.version, credentials: { secretKey: fake.newAccount() } });
    expect([ok.status, ok.body.connectionTest, ok.body.version]).toEqual([200, 'ok', before.version + 1]);
    const rotated = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(rotated.credentialsCiphertext).not.toBe(before.credentialsCiphertext);
    expect(rotated.webhookKeyVersion).not.toBeNull(); // the secret not sent stays
    expect(rotated.lastConnectionTestAt!.getTime()).toBe(rotated.credentialsChangedAt.getTime());
    expect((await view(admin, r.body.id)).connectionTestCurrent).toBe(true);
    const sims = await admin.put(`${ACCOUNTS}/${(await panelSim()).id}/credentials`, { version: 0, credentials: { apiKey: 'x' } });
    expect([sims.status, sims.body.code]).toEqual([422, 'no_credentials_to_change']);
  });

  it('stale_connection_test_not_recorded: a test of old credentials that ends after a rotation is reported, not stored', async () => {
    const r = await admin.post(ACCOUNTS, { adapterKey: 'stripe', displayName: name('Stripe'), mode: 'test', credentials: { secretKey: fake.newAccount() } });
    await admin.put(`${ACCOUNTS}/${r.body.id}/webhook-secret`, { version: (await view(admin, r.body.id)).version, webhookSecret: whsec() });
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      hold = { reached: resolve, release: new Promise<void>((done) => (release = done)) };
    });
    const tester = await freshAdmin();
    const pending = tester.post(`${ACCOUNTS}/${r.body.id}/connection-test`);
    const started = pending.then((x) => x);
    await reached;
    const rotated = await admin.put(`${ACCOUNTS}/${r.body.id}/credentials`, { version: (await view(admin, r.body.id)).version, credentials: { secretKey: fake.newAccount() } });
    expect([rotated.status, rotated.body.connectionTest]).toEqual([200, 'ok']);
    release();
    const late = await started;
    expect([late.status, late.body.result, late.body.recorded]).toEqual([200, 'provider_auth_failed', false]);
    const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row.lastConnectionTestResult).toBe('ok');
    expect(row.lastConnectionTestAt!.getTime()).toBeGreaterThanOrEqual(row.credentialsChangedAt.getTime());
  });
});

describe('statuses (plan 4.1, 4.3)', () => {
  it('pausing_last_account_of_method_warns: 409 with the lost pairs and nothing changed; then confirmed', async () => {
    const who = await freshAdmin();
    const a = await panelSim(who);
    expect((await setStatus(who, a.id, 'active')).status).toBe(200);
    await onlyAccount(t, a.id);
    const warned = await setStatus(who, a.id, 'paused');
    expect([warned.status, warned.body.code]).toEqual([409, 'coverage_loss_unconfirmed']);
    expect(warned.body.lost).toContainEqual({ method: 'card', country: 'AU' });
    expect((await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('active');
    const retire = await setStatus(who, a.id, 'retired');
    expect([retire.status, retire.body.code]).toEqual([409, 'coverage_loss_unconfirmed']);
    const done = await setStatus(who, a.id, 'paused', { confirmCoverageLoss: true, reason: 'Testing the warning' });
    expect([done.status, done.body.lost]).toEqual([200, warned.body.lost]);
    expect((await who.get(`${ACCOUNTS}/warnings`)).body.items).toContainEqual({ code: 'no_method_for_country', country: 'AU' });
  });

  it('concurrent_pauses_of_last_two_accounts_warn_once (advisory lock)', async () => {
    const who = await freshAdmin();
    const a = await panelSim(who);
    const b = await panelSim(who);
    await setStatus(who, a.id, 'active');
    await setStatus(who, b.id, 'active');
    await onlyAccount(t, a.id);
    await t.prisma.providerAccount.update({ where: { id: b.id }, data: { status: 'active', pauseReasonCode: null } });
    const va = (await view(who, a.id)).version;
    const vb = (await view(who, b.id)).version;
    const [ra, rb] = await Promise.all([
      who.post(`${ACCOUNTS}/${a.id}/status`, { version: va, status: 'paused' }),
      who.post(`${ACCOUNTS}/${b.id}/status`, { version: vb, status: 'paused' }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect([ra, rb].find((x) => x.status === 409)!.body.code).toBe('coverage_loss_unconfirmed');
    expect(await t.prisma.providerAccount.count({ where: { id: { in: [a.id, b.id] }, status: 'active' } })).toBe(1);
  });

  it('status_transition_not_allowed and stale versions; the trigger holds the same pairs as the API role', async () => {
    const a = await panelSim();
    const bad = await setStatus(admin, a.id, 'archived');
    expect([bad.status, bad.body.code]).toEqual([409, 'status_transition_not_allowed']);
    const stale = await admin.post(`${ACCOUNTS}/${a.id}/status`, { version: 99, status: 'active' });
    expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
    const svc = t.app.get(ProviderAccountsService);
    const STATUSES = ['active', 'paused', 'retired', 'archived'] as const;
    const path: Record<string, string[]> = { active: [], paused: ['paused'], retired: ['retired'], archived: ['retired', 'archived'] };
    const ALLOWED = new Set(['active>paused', 'paused>active', 'active>retired', 'paused>retired', 'retired>archived']);
    for (const from of STATUSES) for (const to of STATUSES) {
      if (from === to) continue;
      const { id } = await svc.createSimulatorAccount({ displayName: name('Sim') });
      for (const s of path[from]!) await t.prisma.$executeRawUnsafe(`UPDATE provider_accounts SET status = $2::"ProviderAccountStatus" WHERE id = $1::uuid`, id, s);
      const run = t.prisma.$executeRawUnsafe(`UPDATE provider_accounts SET status = $2::"ProviderAccountStatus" WHERE id = $1::uuid`, id, to);
      if (ALLOWED.has(`${from}>${to}`)) await expect(run).resolves.toBe(1);
      else await expect(run).rejects.toThrow(/cannot become/);
      await t.prisma.$executeRawUnsafe(`UPDATE provider_accounts SET status = 'paused' WHERE id = $1::uuid AND status = 'active'`, id);
    }
  });

  it('activation_trigger_requires_current_ok_test and credentials_change_requires_credentials_changed_at', async () => {
    const { id } = await t.app.get(ProviderAccountsService).createSimulatorAccount({ displayName: name('Sim') });
    await t.prisma.providerAccount.update({ where: { id }, data: { status: 'paused' } });
    await t.prisma.providerAccount.update({ where: { id }, data: { lastConnectionTestResult: 'provider_auth_failed' } });
    await expect(t.prisma.providerAccount.update({ where: { id }, data: { status: 'active' } })).rejects.toThrow(/ok connection test/);
    const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } });
    await t.prisma.providerAccount.update({ where: { id }, data: { lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date(row.credentialsChangedAt.getTime() - 1000) } });
    await expect(t.prisma.providerAccount.update({ where: { id }, data: { status: 'active' } })).rejects.toThrow(/ok connection test/);
    await expect(t.prisma.providerAccount.update({ where: { id }, data: { credentialsCiphertext: 'x.y.z' } })).rejects.toThrow(/move credentialsChangedAt forward/);
    await expect(t.prisma.providerAccount.update({ where: { id }, data: { credentialsCiphertext: 'x.y.z', credentialsChangedAt: new Date(row.credentialsChangedAt.getTime() - 1000) } })).rejects.toThrow(/move credentialsChangedAt forward/);
    await expect(t.prisma.providerAccount.update({ where: { id }, data: { credentialsChangedAt: new Date(row.credentialsChangedAt.getTime() + 1000) } })).rejects.toThrow(/only moves with the credentials/);
    await expect(t.prisma.providerAccount.update({ where: { id }, data: { webhookKeyVersion: null } })).rejects.toThrow();
    await expect(t.prisma.providerAccount.update({ where: { id }, data: { pauseReasonCode: 'whatever' } })).rejects.toThrow(/pause_reason/);
  });

  it('account_with_history_not_deletable: no route deletes an account; the API role has no DELETE; the owner meets the trigger', async () => {
    const a = await panelSim();
    expect((await admin.delete(`${ACCOUNTS}/${a.id}`)).status).toBe(404);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM provider_accounts WHERE id = $1::uuid`, a.id)).rejects.toThrow(/permission denied/);
    await expect(t.prisma.$executeRawUnsafe(`TRUNCATE provider_accounts CASCADE`)).rejects.toThrow();
    await asOwner(async (db) => {
      await expect(db.query(`DELETE FROM provider_accounts WHERE id = $1::uuid`, [a.id])).rejects.toThrow(/never deleted/);
    });
  });
});

describe('retired and archived accounts (plan 0.1, 6.4; P11)', () => {
  async function paidOn(acc: SimAccount) {
    const who = await freshAdmin();
    await onlyAccount(t, acc.id);
    const { reference, bookingId } = await approvedBooking(t, who, await pricedWorld(who), c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const p0 = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    sim.settle(acc.id, p0.providerPaymentRef!, 'succeeded');
    expect((await deliver(t, acc, await eventFor(t, acc, p0.id))).outcome).toBe('processed');
    return { reference, bookingId, p: await t.prisma.payment.findUniqueOrThrow({ where: { id: p0.id } }) };
  }

  it('retired_account_refunds_but_rejects_new_charges, archive_rejected_within_dispute_window and archived_account_still_processes_webhooks', async () => {
    const who = await freshAdmin();
    const made = await panelSim(who);
    await setStatus(who, made.id, 'active');
    const acc = await asSim(made.id, made.webhookUrl);
    const { reference, bookingId, p } = await paidOn(acc);
    expect((await setStatus(who, acc.id, 'retired', { confirmCoverageLoss: true })).status).toBe(200);
    // No new charge: not offered, and the gateway door refuses it.
    const gateway = t.app.get(ProviderGateway);
    expect((await t.app.get(PaymentRouting).candidates(t.prisma, { method: 'card', currency: 'AUD', country: 'AU' })).map((a) => a.id)).not.toContain(acc.id);
    await expect(gateway.call(acc.id, 'create', async () => 'reached')).rejects.toMatchObject({ code: 'account_not_accepting_charges' });
    expect([(await c.pay(reference, { method: 'card' })).status]).toEqual([409]);
    // A refund of an old payment still goes through, and its webhook is recorded.
    const refund = await gateway.call(acc.id, 'refund', (provider, ctx) => provider.createRefund(ctx, {
      paymentRef: p.providerPaymentRef!, amount: { amountMinor: 100n, currency: p.currency }, idempotencyKey: `test:${randomUUID()}`,
      metadata: { refundId: randomUUID(), paymentId: p.id, bookingId }, createdAt: new Date(),
    }));
    expect(refund.status).toBe('succeeded');
    const blocked = await setStatus(who, acc.id, 'archived');
    expect([blocked.status, blocked.body.code, blocked.body.reasons]).toEqual([409, 'archive_blocked', ['within_dispute_window']]);
    // Past the window (as the owner: the API never moves dates), archived; a refund event is still processed.
    await asOwner((db) => db.query(`UPDATE provider_accounts SET status = 'archived' WHERE id = $1::uuid`, [acc.id]));
    const second = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 50n);
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, second.ref))).outcome).toBe('processed');
    expect(await t.prisma.refund.count({ where: { providerRefundRef: second.ref, providerAccountId: acc.id } })).toBe(1);
    expect((await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe('archived');
  });

  it('archive_rejected_with_live_attempt; an account with nothing pending archives', async () => {
    const who = await freshAdmin();
    const made = await panelSim(who);
    await setStatus(who, made.id, 'active');
    await onlyAccount(t, made.id);
    const { reference, bookingId } = await approvedBooking(t, who, await pricedWorld(who), c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    expect(await t.prisma.payment.count({ where: { bookingId, providerAccountId: made.id, status: { in: ['created', 'requires_action'] } } })).toBe(1);
    await setStatus(who, made.id, 'retired', { confirmCoverageLoss: true });
    const blocked = await setStatus(who, made.id, 'archived');
    expect([blocked.status, blocked.body.reasons]).toEqual([409, ['live_payment_attempts']]);
    const clean = await panelSim(who);
    await setStatus(who, clean.id, 'retired');
    const archived = await setStatus(who, clean.id, 'archived');
    expect([archived.status, archived.body.status]).toEqual([200, 'archived']);
    expect((await view(who, clean.id)).allowedTransitions).toEqual([]);
  });
});

describe('webhooks per account (finding 2; plan 4.1, 4.4)', () => {
  it('webhook_metadata_id_from_other_account_not_matched and webhook_of_one_account_never_verifies_with_another_secret (panel accounts)', async () => {
    const who = await freshAdmin();
    const ma = await panelSim(who);
    const mb = await panelSim(who);
    await setStatus(who, ma.id, 'active');
    await setStatus(who, mb.id, 'active');
    const a = await asSim(ma.id, ma.webhookUrl);
    const b = await asSim(mb.id, mb.webhookUrl);
    await onlyAccount(t, a.id);
    const { reference, bookingId } = await approvedBooking(t, who, await pricedWorld(who), c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    const wa = await eventFor(t, a, p.id);
    expect((await sendWebhook(t, b, wa)).status).toBe(400);
    const wb = await eventFor(t, b, p.id);
    const res = await deliver(t, b, wb);
    expect([res.status, res.outcome]).toEqual([200, 'ignored']);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).not.toBe('succeeded');
  });

  it('webhook_url_shown_once_and_regenerated_with_step_up: the old URL stops at once, the new one verifies', async () => {
    const made = await panelSim();
    const acc = await asSim(made.id, made.webhookUrl);
    const regen = await admin.post(`${ACCOUNTS}/${made.id}/webhook-url`, { version: (await view(admin, made.id)).version });
    expect(regen.status).toBe(200);
    expect(regen.headers['cache-control']).toBe('no-store');
    const fresh = { ...acc, pathToken: regen.body.webhookUrl.split('/').pop() };
    expect(fresh.pathToken).not.toBe(acc.pathToken);
    const w = sim.paymentEvent(acc.secret, { ref: 'sim_pay_none', status: 'succeeded', amountMinor: 100n, currency: 'AUD' });
    expect((await sendWebhook(t, acc, w)).status).toBe(404);
    expect((await sendWebhook(t, fresh, w)).status).toBe(200);
    const stale = await staleAdmin();
    const r = await stale.post(`${ACCOUNTS}/${made.id}/webhook-url`, { version: (await view(admin, made.id)).version });
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
  });
});

async function staleAdmin() {
  const s = await freshAdmin();
  await t.prisma.session.updateMany({ where: { userId: s.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
  return s;
}

describe('secrets never leave (plan 0.1, 4.7; plan 4.1, 7)', () => {
  it('credential_change_requires_step_up_and_is_audited; a reader cannot change anything', async () => {
    const made = await panelSim();
    const stale = await staleAdmin();
    const v = (await view(admin, made.id)).version;
    const attempts = [
      stale.post(ACCOUNTS, { adapterKey: 'simulator', displayName: name(), mode: 'test' }),
      stale.put(`${ACCOUNTS}/${made.id}/credentials`, { version: v, credentials: {} }),
      stale.put(`${ACCOUNTS}/${made.id}/webhook-secret`, { version: v, webhookSecret: whsec() }),
      stale.post(`${ACCOUNTS}/${made.id}/status`, { version: v, status: 'active' }),
      stale.post(`${ACCOUNTS}/${made.id}/connection-test`),
      stale.patch(`${ACCOUNTS}/${made.id}`, { version: v, displayName: 'x' }),
    ];
    for (const r of await Promise.all(attempts)) expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    const reader = await staffClient(t, ['payments.providerAccount.read']);
    expect((await reader.get(ACCOUNTS)).status).toBe(200);
    expect((await reader.post(ACCOUNTS, { adapterKey: 'simulator', displayName: name(), mode: 'test' })).status).toBe(403);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: made.id, action: 'payments.providerAccount.created' } });
    expect(audit.changes).toMatchObject({ credentialsCiphertext: '[changed]', webhookSecretCiphertext: '[changed]', webhookPathTokenHash: '[changed]' });
  });

  it('credentials_never_returned_or_logged: responses, audit and every log line of a loud app', async () => {
    const loud = await makeApp({}, { allLogs: true });
    const loudKeys = (loud.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
    loudKeys.set('stripe', new StripeProvider({ transport, now: () => fake.now() }));
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), out(chunk as never, ...(rest as [])))) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), err(chunk as never, ...(rest as [])))) as typeof process.stderr.write;
    const key = fake.newAccount();
    const secret = whsec();
    const wrongKey = `sk_test_${'7'.repeat(26)}`;
    const bodies: string[] = [];
    let id = '';
    try {
      const staff = await createStaff(loud, { permissions: PERMS });
      const cookie = await signInStaff(loud, staff);
      const call = (m: 'get' | 'post' | 'put', path: string, body?: object) => {
        const r = loud.http()[m](path).set('Origin', 'http://localhost:3000').set('X-MT-CSRF', '1').set('Cookie', cookie);
        return body ? r.send(body) : r;
      };
      const created = await call('post', ACCOUNTS, { adapterKey: 'stripe', displayName: name('Stripe'), mode: 'test', credentials: { secretKey: key } });
      id = created.body.id;
      const version = async () => ((await call('get', ACCOUNTS)).body.items as Array<{ id: string; version: number }>).find((a) => a.id === id)!.version;
      bodies.push(JSON.stringify(created.body));
      bodies.push(JSON.stringify((await call('put', `${ACCOUNTS}/${id}/webhook-secret`, { version: await version(), webhookSecret: secret })).body));
      bodies.push(JSON.stringify((await call('put', `${ACCOUNTS}/${id}/credentials`, { version: await version(), credentials: { secretKey: wrongKey } })).body));
      bodies.push(JSON.stringify((await call('post', ACCOUNTS, { adapterKey: 'stripe', displayName: name(), mode: 'test', credentials: { secretKey: wrongKey, [wrongKey]: secret } })).body));
      bodies.push(JSON.stringify((await call('post', `${ACCOUNTS}/${id}/connection-test`)).body));
      for (const path of [ACCOUNTS, `${ACCOUNTS}/warnings`, '/admin/payments/adapters', '/admin/settings']) bodies.push(JSON.stringify((await call('get', path)).body));
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      await loud.close();
    }
    const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } });
    const audit = JSON.stringify(await t.prisma.auditLog.findMany({ where: { entityId: id }, include: { piiValues: true } }));
    for (const haystack of [...bodies, audit, written.join('')]) {
      for (const needle of [key, secret, wrongKey, row.credentialsCiphertext, row.webhookSecretCiphertext!, row.webhookPathTokenHash, 'credentialsCiphertext', 'webhookSecretCiphertext']) {
        if (haystack === audit && needle.endsWith('Ciphertext')) continue; // the audit names the column, with "[changed]"
        expect(haystack).not.toContain(needle);
      }
    }
    expect(audit).not.toMatch(/"credentialsCiphertext":(?!"\[changed\]")/);
  });
});

describe('the boot check (plan 4.1, 4.5)', () => {
  it('startup_pauses_account_with_missing_or_planned_adapter: once, audited, one task', async () => {
    const base = await t.prisma.providerAccount.findFirstOrThrow({ where: { adapterKey: 'simulator' } });
    const ghost = randomUUID();
    await t.prisma.providerAccount.create({ data: { ...base, id: ghost, adapterKey: 'ghost', status: 'active', pauseReasonCode: null, version: 0, displayName: name('Ghost'), webhookPathTokenHash: randomBytes(32).toString('hex') } });
    const later = randomUUID();
    await t.prisma.providerAccount.create({ data: { ...base, id: later, adapterKey: 'later', status: 'active', pauseReasonCode: null, version: 0, displayName: name('Later'), webhookPathTokenHash: randomBytes(32).toString('hex') } });
    const registry = t.app.get(PaymentAdapterRegistry);
    const original = registry.get.bind(registry);
    const plannedManifest = { ...base, status: 'planned' } as unknown as AdapterManifest;
    const spy = vi.spyOn(registry, 'get').mockImplementation((k: string) => (k === 'later' ? ({ manifest: { ...original('simulator')!.manifest, ...plannedManifest, key: 'later', status: 'planned' } } as PaymentProvider) : original(k)));
    try {
      const boot = t.app.get(ProviderAccountsBootCheck);
      const first = await boot.run();
      expect(first).toEqual(expect.arrayContaining([ghost, later]));
      expect(await boot.run()).not.toEqual(expect.arrayContaining([ghost]));
      const rows = await t.prisma.providerAccount.findMany({ where: { id: { in: [ghost, later] } }, orderBy: { adapterKey: 'asc' } });
      expect(rows.map((r) => [r.adapterKey, r.status, r.pauseReasonCode])).toEqual([['ghost', 'paused', 'boot_adapter_missing'], ['later', 'paused', 'boot_adapter_planned']]);
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:account_paused_at_boot:${ghost}` } })).toBe(1);
      expect(await t.prisma.auditLog.count({ where: { entityId: ghost, action: 'payments.providerAccount.pausedAtBoot' } })).toBe(1);
      const warnings = (await admin.get(`${ACCOUNTS}/warnings`)).body.items;
      expect(warnings).toContainEqual({ code: 'paused_by_system', accountId: ghost, reason: 'boot_adapter_missing' });
      expect(warnings).toContainEqual({ code: 'adapter_missing', accountId: ghost });
      const reactivate = await setStatus(admin, ghost, 'active');
      expect([reactivate.status, reactivate.body.code]).toEqual([409, 'adapter_unavailable']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("3.3's review notes (plan 4.1, section 9)", () => {
  it('internal_settings_hidden_from_panel', async () => {
    const owner = await createStaff(t, { owner: true });
    const cookie = await signInStaff(t, owner);
    const list = await t.http().get('/admin/settings').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('paymentLedgerCheckCursor');
    expect(JSON.stringify(list.body)).toContain('paymentDisputeWindowDays');
    const put = await t.http().put('/admin/settings/paymentLedgerCheckCursor').set('Origin', 'http://localhost:3000').set('X-MT-CSRF', '1').set('Cookie', cookie).send({ value: '', version: 0 });
    expect([put.status, put.body.code]).toEqual([404, 'setting_unknown']);
  });

  it('ledger_check_cursor_saved_after_tasks: a run that fails opening tasks does not move the cursor', async () => {
    const settings = t.app.get(SettingsService);
    const key = 'paymentLedgerCheckCursor';
    const svc = t.app.get(PaymentLedgerCheckService);
    const page = vi.spyOn(svc, 'checkPage').mockResolvedValue({ findings: [{ kind: 'booking_total', entityType: 'Booking', entityId: randomUUID() }], next: randomUUID() });
    const tasks = vi.spyOn(t.app.get(TasksService), 'createSystemIn').mockRejectedValue(new Error('tasks down'));
    const before = await settings.get<string>(key, '');
    try {
      await expect(svc.run()).rejects.toThrow('tasks down');
      expect(await settings.get<string>(key, '')).toBe(before);
    } finally {
      page.mockRestore();
      tasks.mockRestore();
    }
  });
});

describe('review of the code (PR #73)', () => {
  it('unreadable_credentials_result_tied_to_the_ciphertexts_read: a rotation after the read is never marked unreadable', async () => {
    const { id } = await t.app.get(ProviderAccountsService).createSimulatorAccount({ displayName: name('Sim') });
    await t.prisma.providerAccount.update({ where: { id }, data: { status: 'paused' } });
    // Unreadable: a key version that is not configured (the change time moves with it, as the trigger wants).
    const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } });
    await t.prisma.providerAccount.update({ where: { id }, data: { credentialsKeyVersion: row.credentialsKeyVersion + 7, credentialsChangedAt: new Date(row.credentialsChangedAt.getTime() + 1000) } });
    const unreadableAt = (await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } })).credentialsChangedAt;
    const gateway = t.app.get(ProviderGateway);
    const original = gateway.testConnection.bind(gateway);
    // Right after the gateway's read, a rotation (readable again) commits before the result is stored.
    const spy = vi.spyOn(gateway, 'testConnection').mockImplementation(async (accountId: string) => {
      const out = await original(accountId);
      await t.prisma.providerAccount.update({ where: { id }, data: { credentialsKeyVersion: row.credentialsKeyVersion, credentialsChangedAt: new Date(unreadableAt.getTime() + 1000), lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date(unreadableAt.getTime() + 2000) } });
      return out;
    });
    try {
      const r = await admin.post(`${ACCOUNTS}/${id}/connection-test`);
      expect([r.status, r.body.result, r.body.recorded]).toEqual([200, 'credentials_unreadable', false]);
      const [first] = await spy.mock.results.map((x) => x.value as Promise<{ credentialsChangedAt: Date }>);
      expect((await first!).credentialsChangedAt.getTime()).toBe(unreadableAt.getTime());
      expect((await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } })).lastConnectionTestResult).toBe('ok');
    } finally {
      spy.mockRestore();
    }
  });

  it('api_key_rejected_on_account_routes: a key never reaches a gateway account route', async () => {
    const staff = await createStaff(t, { permissions: [...new Set([...PERMS, CATALOGUE_PERMISSIONS.raceRead, IP.apiKeyRead, IP.apiKeyManage])] });
    const cookie = await signInStaff(t, staff);
    const made = await t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', cookie).send({ name: 'Gateway probe', scopes: [CATALOGUE_PERMISSIONS.raceRead] });
    expect(made.status).toBe(201);
    const bearer = `Bearer ${made.body.token as string}`;
    const id = (await panelSim()).id;
    const calls = [
      t.http().get('/admin/payments/adapters'), t.http().get(ACCOUNTS), t.http().get(`${ACCOUNTS}/warnings`),
      t.http().post(ACCOUNTS).send({ adapterKey: 'simulator', displayName: name(), mode: 'test' }),
      t.http().patch(`${ACCOUNTS}/${id}`).send({ version: 0, displayName: 'x' }),
      t.http().post(`${ACCOUNTS}/${id}/status`).send({ version: 0, status: 'active' }),
      t.http().post(`${ACCOUNTS}/${id}/connection-test`),
      t.http().put(`${ACCOUNTS}/${id}/credentials`).send({ version: 0, credentials: {} }),
      t.http().put(`${ACCOUNTS}/${id}/webhook-secret`).send({ version: 0, webhookSecret: whsec() }),
      t.http().post(`${ACCOUNTS}/${id}/webhook-url`).send({ version: 0 }),
    ];
    for (const r of await Promise.all(calls.map((c) => c.set('Authorization', bearer)))) expect(r.status).toBe(403);
    expect((await t.prisma.providerAccount.findUniqueOrThrow({ where: { id } })).version).toBe(0);
    expect((await t.http().post(`/admin/integrations/api-keys/${made.body.id as string}/revoke`).set(STATE_HEADERS).set('Cookie', cookie)).status).toBe(204);
  });

  it('method_switch_and_account_pause_share_the_coverage_lock', async () => {
    const guard = t.app.get(CollectionCoverageGuard);
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const held = t.prisma.$transaction(async (tx) => {
      await guard.lock(tx);
      locked();
      await new Promise<void>((r) => (release = r));
    }, { timeout: 60_000 });
    await isLocked;
    const list = await admin.get('/admin/payments/methods');
    const version = (list.body.items as Array<{ method: string; version: number }>).find((m) => m.method === 'manual_other')!.version;
    const made = await panelSim();
    const finished: string[] = [];
    const put = admin.put('/admin/payments/methods/manual_other', { version, enabled: false, countries: [], displayOrder: 0, instructions: null, payeeName: null, payId: null, bank: null }).then((r) => (finished.push('method'), r));
    const pause = admin.post(`${ACCOUNTS}/${made.id}/status`, { version: 0, status: 'retired' }).then((r) => (finished.push('account'), r));
    await new Promise((r) => setTimeout(r, 800));
    expect(finished).toEqual([]);
    release();
    await held;
    const [rm, ra] = await Promise.all([put, pause]);
    expect([200, 409]).toContain(rm.status);
    expect(ra.status).toBe(200);
    expect(finished.sort()).toEqual(['account', 'method']);
  });
});
