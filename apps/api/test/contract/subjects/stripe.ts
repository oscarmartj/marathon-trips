// The Stripe adapter's contract subjects (plan docs/plans/3.3-stripe-adapter-ledger.md, section 6). Local: the
// registered StripeProvider class talking to the in-process fake. Sandbox: the same class against Stripe's sandbox,
// credentials from STRIPE_SANDBOX_SECRET_KEY and STRIPE_SANDBOX_WEBHOOK_SECRET (test keys only); written and
// type-checked, never run here (no keys): the customer's part drives Stripe Checkout in a browser.
import { randomBytes, randomUUID } from 'node:crypto';
import { signStripe } from '../../../src/modules/payments/adapters/stripe/mapping';
import { StripeProvider } from '../../../src/modules/payments/adapters/stripe/stripe';
import type { ProviderContext } from '../../../src/modules/payments/core/provider';
import type { ContractSubject } from '../payment-provider.contract';
import { FakeStripe } from './stripe-fake';

const sessionIdOf = (ref: string): string => ref;

interface PwLocator { fill(v: string): Promise<void>; click(): Promise<void> }
interface PwPage {
  goto(url: string): Promise<unknown>;
  getByLabel(re: RegExp): PwLocator;
  getByPlaceholder(t: string): PwLocator;
  getByRole(role: string, o: { name: RegExp }): PwLocator;
  waitForTimeout(ms: number): Promise<void>;
}
interface PwBrowser { newPage(): Promise<PwPage>; close(): Promise<void> }

export function stripeLocalSubject(fake = new FakeStripe()): ContractSubject {
  const provider = new StripeProvider({ transport: fake.transport, now: () => fake.now() });
  const keyOf = (ctx: ProviderContext) => ctx.credentials.secretKey!;
  return {
    provider,
    async context() {
      return { accountId: randomUUID(), mode: 'test', credentials: { secretKey: fake.newAccount() }, webhookSecret: `whsec_${randomBytes(24).toString('hex')}` };
    },
    // A well-formed test key Stripe does not know: 401.
    badCredentials: (ctx) => ({ ...ctx, credentials: { secretKey: `sk_test_${randomBytes(16).toString('hex')}` } }),
    async customerCompletes(ctx, payment, outcome) {
      if (outcome === 'pay') fake.pay(keyOf(ctx), sessionIdOf(payment.ref));
      else fake.decline(keyOf(ctx), sessionIdOf(payment.ref));
    },
    async endAtGateway(ctx, payment) {
      fake.expire(keyOf(ctx), sessionIdOf(payment.ref));
    },
    async webhookFor(ctx, ref, at) {
      const w = fake.event(keyOf(ctx), ctx.webhookSecret, ref, at);
      return { body: w.body, headers: w.headers };
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      const r = fake.dashboardRefund(keyOf(ctx), sessionIdOf(payment.ref), Number(amountMinor));
      return (await provider.retrieveRefund(ctx, { ref: r.id }))!;
    },
    async refundWebhookFor(ctx, refundRef, at) {
      const w = fake.event(keyOf(ctx), ctx.webhookSecret, refundRef, at);
      return { body: w.body, headers: w.headers };
    },
    async cardholderDisputes(ctx, payment) {
      return { ref: fake.openDispute(keyOf(ctx), sessionIdOf(payment.ref)).id };
    },
    async disputeMoves(ctx, ref, to) {
      fake.moveDispute(keyOf(ctx), ref, { ...(to.status ? { status: to.status } : {}), ...(to.withdraw ? { withdraw: true } : {}), ...(to.reinstate ? { reinstate: true } : {}) });
    },
    async disputeWebhookFor(ctx, ref, at) {
      const w = fake.event(keyOf(ctx), ctx.webhookSecret, ref, at);
      return { body: w.body, headers: w.headers };
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials() {
      throw new Error('the local Stripe subject uses the fake: run the sandbox subject');
    },
  };
}

/** Stripe's sandbox. The browser part follows Stripe's documented test cards; unverified until keys exist. */
export function stripeSandboxSubject(): ContractSubject {
  const provider = new StripeProvider();
  const env = process.env;
  const api = async (ctx: ProviderContext, path: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`https://api.stripe.com${path}`, { headers: { authorization: `Bearer ${ctx.credentials.secretKey}`, 'stripe-version': '2026-10-28.endive' } });
    if (!res.ok) throw new Error(`stripe sandbox: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const checkout = async (url: string, card: string): Promise<void> => {
    // Not a dependency of the API: whoever runs the Stripe sandbox adds it first (docs/done/3.3.md).
    const moduleName = 'playwright';
    const { chromium } = (await import(moduleName)) as { chromium: { launch: (o: object) => Promise<PwBrowser> } };
    const browser = await chromium.launch({ channel: env.PW_CHANNEL || undefined });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByLabel(/email/i).fill('contract-test@example.com');
      await page.getByPlaceholder('1234 1234 1234 1234').fill(card);
      await page.getByPlaceholder('MM / YY').fill('12 / 34');
      await page.getByPlaceholder('CVC').fill('123');
      await page.getByLabel(/name on card|cardholder/i).fill('Contract Test');
      await page.getByRole('button', { name: /pay/i }).click();
      await page.waitForTimeout(8_000);
    } finally {
      await browser.close();
    }
  };
  const sign = (ctx: ProviderContext, event: Record<string, unknown>, at: Date) => {
    const body = Buffer.from(JSON.stringify(event));
    return { body, headers: { 'content-type': 'application/json', 'stripe-signature': signStripe(ctx.webhookSecret, body, at) } };
  };
  return {
    provider,
    async context() {
      return { accountId: randomUUID(), mode: 'test', credentials: { secretKey: env.STRIPE_SANDBOX_SECRET_KEY ?? '' }, webhookSecret: env.STRIPE_SANDBOX_WEBHOOK_SECRET ?? '' };
    },
    badCredentials: (ctx) => ({ ...ctx, credentials: { secretKey: `sk_test_${randomBytes(16).toString('hex')}` } }),
    async customerCompletes(ctx, payment, outcome) {
      const s = await api(ctx, `/v1/checkout/sessions/${payment.ref}`);
      if (s.status !== 'open' || typeof s.url !== 'string') throw new Error('stripe sandbox: the session is not open');
      await checkout(s.url, outcome === 'pay' ? '4242424242424242' : '4000000000000002');
    },
    async endAtGateway(ctx, payment) {
      await provider.cancelPayment(ctx, payment.ref, `contract-end:${payment.ref}`);
    },
    async webhookFor(ctx, ref, at) {
      // The object as Stripe holds it now, in an event envelope signed with the endpoint secret.
      const object = await api(ctx, `/v1/checkout/sessions/${ref}`);
      const type = object.status === 'expired' ? 'checkout.session.expired' : 'checkout.session.completed';
      return sign(ctx, { id: `evt_contract_${randomBytes(8).toString('hex')}`, object: 'event', type, created: Math.floor(at.getTime() / 1000), livemode: false, data: { object } }, at);
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      // The dashboard is a person; its API call without our metadata is the same refund to Stripe.
      const s = await api(ctx, `/v1/checkout/sessions/${payment.ref}`);
      const res = await fetch('https://api.stripe.com/v1/refunds', {
        method: 'POST', headers: { authorization: `Bearer ${ctx.credentials.secretKey}`, 'stripe-version': '2026-10-28.endive', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ payment_intent: String(s.payment_intent), amount: amountMinor.toString() }).toString(),
      });
      const r = (await res.json()) as { id: string };
      return (await provider.retrieveRefund(ctx, { ref: r.id }))!;
    },
    async refundWebhookFor(ctx, refundRef, at) {
      const object = await api(ctx, `/v1/refunds/${refundRef}`);
      return sign(ctx, { id: `evt_contract_${randomBytes(8).toString('hex')}`, object: 'event', type: 'refund.updated', created: Math.floor(at.getTime() / 1000), livemode: false, data: { object } }, at);
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials(e) {
      if (!/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(e.STRIPE_SANDBOX_SECRET_KEY ?? '')) throw new Error('test:sandbox stripe: STRIPE_SANDBOX_SECRET_KEY must be a test-mode key');
      if (!/^whsec_[A-Za-z0-9]{10,}$/.test(e.STRIPE_SANDBOX_WEBHOOK_SECRET ?? '')) throw new Error('test:sandbox stripe: STRIPE_SANDBOX_WEBHOOK_SECRET is missing');
    },
  };
}
