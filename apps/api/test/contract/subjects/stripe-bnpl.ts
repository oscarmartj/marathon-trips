// The pay-later adapter's contract subjects (plan docs/plans/9.3-stripe-pay-later.md, section 11). Local: the registered
// StripeBnplProvider class against the in-process Stripe fake, with pay-later sessions. Sandbox: the same class against
// the sandbox of the Stripe account used only for pay later, credentials from STRIPE_BNPL_SANDBOX_SECRET_KEY and
// STRIPE_BNPL_SANDBOX_WEBHOOK_SECRET (test keys only); written and type-checked, never run here (no keys). The browser
// part presses the test-mode authorise or fail action of the provider's page (A12, unverified).
import { randomBytes, randomUUID } from 'node:crypto';
import { StripeBnplProvider } from '../../../src/modules/payments/adapters/stripe/bnpl';
import { signStripe } from '../../../src/modules/payments/adapters/stripe/mapping';
import type { ProviderContext } from '../../../src/modules/payments/core/provider';
import type { ContractSubject } from '../payment-provider.contract';
import { stripeLocalSubject } from './stripe';
import { FakeStripe } from './stripe-fake';

interface PwLocator { fill(v: string): Promise<void>; click(): Promise<void> }
interface PwPage {
  goto(url: string): Promise<unknown>;
  getByLabel(re: RegExp): PwLocator;
  getByRole(role: string, o: { name: RegExp }): PwLocator;
  waitForTimeout(ms: number): Promise<void>;
}
interface PwBrowser { newPage(): Promise<PwPage>; close(): Promise<void> }

export function stripeBnplLocalSubject(fake = new FakeStripe()): ContractSubject {
  return stripeLocalSubject(fake, (o) => new StripeBnplProvider(o));
}

export function stripeBnplSandboxSubject(): ContractSubject {
  const provider = new StripeBnplProvider();
  const env = process.env;
  const api = async (ctx: ProviderContext, path: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`https://api.stripe.com${path}`, { headers: { authorization: `Bearer ${ctx.credentials.secretKey}`, 'stripe-version': '2026-10-28.endive' } });
    if (!res.ok) throw new Error(`stripe pay later sandbox: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const checkout = async (url: string, outcome: 'pay' | 'decline'): Promise<void> => {
    // Not a dependency of the API: whoever runs the sandbox adds it first (guide, "Stripe pay later").
    const moduleName = 'playwright';
    const { chromium } = (await import(moduleName)) as { chromium: { launch: (o: object) => Promise<PwBrowser> } };
    const browser = await chromium.launch({ channel: env.PW_CHANNEL || undefined });
    try {
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByLabel(/email/i).fill('contract-test@example.com');
      await page.getByRole('radio', { name: /afterpay/i }).click();
      await page.getByRole('button', { name: /pay|continue/i }).click();
      await page.waitForTimeout(5_000);
      await page.getByRole('button', { name: outcome === 'pay' ? /authori[sz]e test payment/i : /fail test payment/i }).click();
      await page.waitForTimeout(8_000);
    } finally {
      await browser.close();
    }
  };
  const sign = (ctx: ProviderContext, event: Record<string, unknown>, at: Date) => {
    const body = Buffer.from(JSON.stringify(event));
    return { body, headers: { 'content-type': 'application/json', 'stripe-signature': signStripe(ctx.webhookSecret, body, at) } };
  };
  const envelope = (type: string, object: Record<string, unknown>, at: Date) => ({ id: `evt_contract_${randomBytes(8).toString('hex')}`, object: 'event', type, created: Math.floor(at.getTime() / 1000), livemode: false, data: { object } });
  return {
    provider,
    async context() {
      return { accountId: randomUUID(), mode: 'test', credentials: { secretKey: env.STRIPE_BNPL_SANDBOX_SECRET_KEY ?? '' }, webhookSecret: env.STRIPE_BNPL_SANDBOX_WEBHOOK_SECRET ?? '' };
    },
    badCredentials: (ctx) => ({ ...ctx, credentials: { secretKey: `sk_test_${randomBytes(16).toString('hex')}` } }),
    async customerCompletes(ctx, payment, outcome) {
      const s = await api(ctx, `/v1/checkout/sessions/${payment.ref}`);
      if (s.status !== 'open' || typeof s.url !== 'string') throw new Error('stripe pay later sandbox: the session is not open');
      await checkout(s.url, outcome);
    },
    async endAtGateway(ctx, payment) {
      await provider.cancelPayment(ctx, payment.ref, `contract-end:${payment.ref}`);
    },
    async webhookFor(ctx, ref, at) {
      const object = await api(ctx, `/v1/checkout/sessions/${ref}`);
      return sign(ctx, envelope(object.status === 'expired' ? 'checkout.session.expired' : 'checkout.session.completed', object, at), at);
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
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
      return sign(ctx, envelope('refund.updated', object, at), at);
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials(e) {
      if (!/^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(e.STRIPE_BNPL_SANDBOX_SECRET_KEY ?? '')) throw new Error('test:sandbox stripe_bnpl: STRIPE_BNPL_SANDBOX_SECRET_KEY must be a test-mode key');
      if (!/^whsec_[A-Za-z0-9]{10,}$/.test(e.STRIPE_BNPL_SANDBOX_WEBHOOK_SECRET ?? '')) throw new Error('test:sandbox stripe_bnpl: STRIPE_BNPL_SANDBOX_WEBHOOK_SECRET is missing');
    },
  };
}
