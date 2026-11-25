// The Airwallex adapter's contract subjects (plan docs/plans/9.2-airwallex.md, sections 13, 14, 19 and 20). Local: the
// registered AirwallexProvider class talking to the in-process fake. Sandbox: the same class against Airwallex's sandbox,
// credentials from AIRWALLEX_SANDBOX_* (written and type-checked, never run here: no sandbox account). The sandbox run
// also requires real recorded deliveries (plan 20.2 and 20.4): a checkout_session.created read as a payment event with
// our id, a payment_intent.succeeded, a refund event, and one event delivered twice with different x-timestamp values
// (a retry signed again, A19). Without them the run fails, so no `N/N` line exists and the adapter cannot be verified.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AirwallexProvider } from '../../../src/modules/payments/adapters/airwallex/airwallex';
import { AIRWALLEX_API_BASE, AIRWALLEX_API_VERSION } from '../../../src/modules/payments/adapters/airwallex/http';
import type { ProviderContext } from '../../../src/modules/payments/core/provider';
import type { ContractSubject, SignedBody } from '../payment-provider.contract';
import { FakeAirwallex, signedDelivery } from './airwallex-fake';

export function airwallexLocalSubject(fake = new FakeAirwallex()): ContractSubject {
  const provider = new AirwallexProvider({ transport: fake.transport, now: () => fake.now() });
  const idOf = (ctx: ProviderContext) => ctx.credentials.clientId!;
  return {
    provider,
    async context() {
      return { accountId: randomUUID(), mode: 'test', credentials: { ...fake.newAccount() }, webhookSecret: `whsec_${randomBytes(24).toString('hex')}` };
    },
    // Well-formed credentials Airwallex does not know: the login answers 401.
    badCredentials: (ctx) => ({ ...ctx, credentials: { clientId: `C${randomBytes(12).toString('hex')}`, apiKey: randomBytes(32).toString('hex') } }),
    async customerCompletes(ctx, payment, outcome) {
      if (outcome === 'pay') fake.pay(idOf(ctx), payment.ref);
      else fake.decline(idOf(ctx), payment.ref);
    },
    async endAtGateway(ctx, payment) {
      fake.expire(idOf(ctx), payment.ref);
    },
    async webhookFor(ctx, ref, at) {
      return signedDelivery(ctx.webhookSecret, fake.paymentEvent(idOf(ctx), ref, at), at);
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      const r = fake.dashboardRefund(idOf(ctx), payment.ref, amountMinor);
      return (await provider.retrieveRefund(ctx, { ref: r.id }))!;
    },
    async refundWebhookFor(ctx, refundRef, at) {
      return signedDelivery(ctx.webhookSecret, fake.refundEvent(idOf(ctx), refundRef, at), at);
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials() {
      throw new Error('the local Airwallex subject uses the fake: run the sandbox subject');
    },
  };
}

interface RecordedDelivery {
  headers: Record<string, string>;
  bodyBase64: string;
  receivedAt: string;
}

interface PwLocator { fill(v: string): Promise<void>; click(): Promise<void> }
interface PwPage {
  goto(url: string): Promise<unknown>;
  getByLabel(re: RegExp): PwLocator;
  getByRole(role: string, o: { name: RegExp }): PwLocator;
  waitForTimeout(ms: number): Promise<void>;
}
interface PwBrowser { newPage(): Promise<PwPage>; close(): Promise<void> }

/** Airwallex's sandbox. The browser part and the card numbers are set in the sandbox session (plan 14); unverified. */
export function airwallexSandboxSubject(): ContractSubject {
  const provider = new AirwallexProvider();
  const env = process.env;
  let checkedRecorded = false;
  const ctxOf = (): ProviderContext => ({
    accountId: randomUUID(), mode: 'test',
    credentials: { clientId: env.AIRWALLEX_SANDBOX_CLIENT_ID ?? '', apiKey: env.AIRWALLEX_SANDBOX_API_KEY ?? '' },
    webhookSecret: env.AIRWALLEX_SANDBOX_WEBHOOK_SECRET ?? '',
  });
  const token = async (ctx: ProviderContext): Promise<string> => {
    const res = await fetch(`${AIRWALLEX_API_BASE.test}/api/v1/authentication/login`, { method: 'POST', headers: { 'x-client-id': ctx.credentials.clientId!, 'x-api-key': ctx.credentials.apiKey!, 'x-api-version': AIRWALLEX_API_VERSION, 'content-type': 'application/json' }, body: '{}' });
    if (!res.ok) throw new Error(`airwallex sandbox: login ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  };
  const api = async (ctx: ProviderContext, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${AIRWALLEX_API_BASE.test}${path}`, { method, headers: { authorization: `Bearer ${await token(ctx)}`, 'x-api-version': AIRWALLEX_API_VERSION, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(`airwallex sandbox: ${method} ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const sessionOf = async (ctx: ProviderContext, ref: string): Promise<Record<string, unknown>> => {
    const t = Number(ref.slice(-10));
    const list = await api(ctx, 'GET', `/api/v1/checkout/checkout_sessions?from_created_at=${new Date((t - 300) * 1000).toISOString()}&page_size=100`);
    const s = (list.items as Array<Record<string, unknown>>).find((x) => (x.payment_intent_data as { merchant_order_id?: string } | undefined)?.merchant_order_id === ref);
    if (!s) throw new Error('airwallex sandbox: no session for that ref');
    return s;
  };
  const checkout = async (url: string, card: string): Promise<void> => {
    // Not a dependency of the API: whoever runs the Airwallex sandbox adds it first (docs/adding-a-payment-adapter.md).
    const moduleName = 'playwright';
    const { chromium } = (await import(moduleName)) as { chromium: { launch: (o: object) => Promise<PwBrowser> } };
    const browser = await chromium.launch({ channel: env.PW_CHANNEL || undefined });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByLabel(/card number/i).fill(card);
      await page.getByLabel(/expir/i).fill('12/34');
      await page.getByLabel(/cvc|cvv|security/i).fill('123');
      await page.getByLabel(/name/i).fill('Contract Test');
      await page.getByRole('button', { name: /pay/i }).click();
      await page.waitForTimeout(8_000);
    } finally {
      await browser.close();
    }
  };
  function checkRecorded(ctx: ProviderContext): void {
    const recorded = JSON.parse(readFileSync(env.AIRWALLEX_SANDBOX_RECORDED_DELIVERY!, 'utf8')) as RecordedDelivery[];
    let sessionCreated = false;
    let paid = false;
    let refund = false;
    const timestampsById = new Map<string, Set<string>>();
    for (const d of recorded) {
      const body = Buffer.from(d.bodyBase64, 'base64');
      const v = provider.verifyWebhook(ctx, body, d.headers, new Date(d.receivedAt));
      if (!v.ok) throw new Error(`airwallex sandbox: a recorded delivery does not verify (${v.code})`);
      const e = v.event;
      const stamps = timestampsById.get(e.providerEventId) ?? new Set<string>();
      stamps.add(d.headers['x-timestamp'] ?? '');
      timestampsById.set(e.providerEventId, stamps);
      // A20 (plan 20.2): the real session event is a payment event with our id, not only an event a GET could rebuild.
      if (e.type === 'checkout_session.created' && e.kind === 'payment' && e.payment?.status === 'requires_action' && e.payment.ourPaymentId) sessionCreated = true;
      if (e.type === 'payment_intent.succeeded' && e.kind === 'payment' && e.payment?.status === 'succeeded' && e.payment.ourPaymentId) paid = true;
      if (e.kind === 'refund') refund = true;
    }
    if (!sessionCreated) throw new Error('airwallex sandbox: record a real checkout_session.created delivery (A20)');
    if (!paid || !refund) throw new Error('airwallex sandbox: record a payment_intent.succeeded and a refund delivery (A10, A11)');
    // A19 (plan 20.4): a retry is signed again with a new x-timestamp.
    if (![...timestampsById.values()].some((s) => s.size >= 2)) throw new Error('airwallex sandbox: record one event delivered twice, its retry signed with a new x-timestamp (A19)');
  }
  return {
    provider,
    async context() {
      const ctx = ctxOf();
      if (!checkedRecorded) {
        checkRecorded(ctx);
        checkedRecorded = true;
      }
      return ctx;
    },
    badCredentials: (ctx) => ({ ...ctx, credentials: { clientId: `C${randomBytes(12).toString('hex')}`, apiKey: randomBytes(32).toString('hex') } }),
    async customerCompletes(ctx, payment, outcome) {
      const s = await sessionOf(ctx, payment.ref);
      if (s.status !== 'ACTIVE' || typeof s.url !== 'string') throw new Error('airwallex sandbox: the session is not active');
      await checkout(s.url, outcome === 'pay' ? env.AIRWALLEX_SANDBOX_CARD_PAY ?? '' : env.AIRWALLEX_SANDBOX_CARD_DECLINE ?? '');
    },
    async endAtGateway(ctx, payment) {
      // Plan 20 (round 1, point 8): Airwallex's own documented cancel, not our cancelPayment; the one-hour expiry is
      // checked once by hand (guide).
      const s = await sessionOf(ctx, payment.ref);
      await api(ctx, 'POST', `/api/v1/checkout/checkout_sessions/${String(s.id)}/cancel`);
    },
    async webhookFor(ctx, ref, at): Promise<SignedBody> {
      // Rebuilt from a GET and signed with the subscription's secret; the real deliveries are checked by checkRecorded.
      const s = await sessionOf(ctx, ref);
      const intentId = typeof s.payment_intent_id === 'string' ? s.payment_intent_id : undefined;
      const object = intentId ? await api(ctx, 'GET', `/api/v1/pa/payment_intents/${intentId}`) : s;
      const name = intentId ? `payment_intent.${String(object.status).toLowerCase()}` : s.status === 'CANCELLED' ? 'checkout_session.cancelled' : 'checkout_session.created';
      return signedDelivery(ctx.webhookSecret, { id: `evt_contract_${randomBytes(8).toString('hex')}`, name, created_at: at.toISOString(), data: { object } }, at);
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      // The web app is a person; the same refund through the API without our metadata is the same to Airwallex.
      const s = await sessionOf(ctx, payment.ref);
      const r = await api(ctx, 'POST', '/api/v1/pa/refunds/create', { request_id: randomUUID(), payment_intent_id: s.payment_intent_id, amount: `${amountMinor / 100n}.${(amountMinor % 100n).toString().padStart(2, '0')}` });
      return (await provider.retrieveRefund(ctx, { ref: String(r.id) }))!;
    },
    async refundWebhookFor(ctx, refundRef, at) {
      const r = await api(ctx, 'GET', `/api/v1/pa/refunds/${refundRef}`);
      return signedDelivery(ctx.webhookSecret, { id: `evt_contract_${randomBytes(8).toString('hex')}`, name: `refund.${String(r.status).toLowerCase()}`, created_at: at.toISOString(), data: { object: r } }, at);
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials(e) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(e.AIRWALLEX_SANDBOX_CLIENT_ID ?? '') || !/^[A-Za-z0-9_-]{32,256}$/.test(e.AIRWALLEX_SANDBOX_API_KEY ?? '')) throw new Error('test:sandbox airwallex: AIRWALLEX_SANDBOX_CLIENT_ID and AIRWALLEX_SANDBOX_API_KEY are missing');
      if (!/^[A-Za-z0-9_+/=-]{16,256}$/.test(e.AIRWALLEX_SANDBOX_WEBHOOK_SECRET ?? '')) throw new Error('test:sandbox airwallex: AIRWALLEX_SANDBOX_WEBHOOK_SECRET is missing');
      if (!e.AIRWALLEX_SANDBOX_CARD_PAY || !e.AIRWALLEX_SANDBOX_CARD_DECLINE) throw new Error('test:sandbox airwallex: the sandbox test cards are missing');
      if (!e.AIRWALLEX_SANDBOX_RECORDED_DELIVERY) throw new Error('test:sandbox airwallex: AIRWALLEX_SANDBOX_RECORDED_DELIVERY (session, payment, refund and a re-signed retry) is mandatory evidence');
    },
  };
}
