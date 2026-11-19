// The PayPal adapter's contract subjects (plan docs/plans/4.3-paypal-adapter.md, section 10). Local: the registered
// PayPalProvider class against the in-process fake. Sandbox: the same class against PayPal's sandbox, credentials from
// PAYPAL_SANDBOX_* variables; written and type-checked, never run here (no sandbox app): the payer's part drives
// PayPal's approval page in a browser.
import { randomBytes, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PayPalProvider } from '../../../src/modules/payments/adapters/paypal/paypal';
import { PAYPAL_HEADERS, PAYPAL_LEAF_NAMES, signedMessage } from '../../../src/modules/payments/adapters/paypal/webhook';
import type { ProviderContext, ProviderPayment } from '../../../src/modules/payments/core/provider';
import type { ContractSubject, SignedBody } from '../payment-provider.contract';
import { FakePayPal } from './paypal-fake';
import { paypalTestChain } from './paypal-certs';

const idOf = (ctx: ProviderContext) => ctx.credentials.clientId!;

/** A well-formed client ID and secret PayPal does not know: 401. */
const unknownCredentials = (ctx: ProviderContext): ProviderContext => ({
  ...ctx, credentials: { clientId: `A${randomBytes(30).toString('base64url')}`, clientSecret: `E${randomBytes(30).toString('base64url')}` },
});

/** The core finishes an approved payment (sync, drive, expire): what the return page does after PayPal sends the payer back. */
async function finish(provider: PayPalProvider, ctx: ProviderContext, payment: ProviderPayment): Promise<ProviderPayment> {
  return provider.completePayment(ctx, payment.ref, `contract-complete:${payment.ref}`);
}

export function paypalLocalSubject(fake = new FakePayPal()): ContractSubject & { fake: FakePayPal; provider: PayPalProvider } {
  const provider = new PayPalProvider({ transport: fake.transport, now: () => fake.now(), certificates: fake.trust });
  return {
    fake,
    provider,
    async context() {
      const acc = fake.newAccount();
      return { accountId: randomUUID(), mode: 'test', credentials: { clientId: acc.clientId, clientSecret: acc.clientSecret }, webhookSecret: acc.webhookId };
    },
    badCredentials: unknownCredentials,
    async customerCompletes(ctx, payment, outcome) {
      fake.approve(idOf(ctx), payment.ref, outcome === 'pay' ? 'good' : 'decline');
      const after = await finish(provider, ctx, payment);
      // Nobody captures a cancelled or ended order, so the payer's approval collects nothing.
      if (outcome === 'pay' && after.status !== 'succeeded') throw new Error('fake paypal: the payment was not collected');
    },
    async endAtGateway(ctx, payment) {
      // The end PayPal itself gives an unpaid order: its risk checks decline the capture (order COMPLETED, capture DECLINED).
      fake.approve(idOf(ctx), payment.ref, 'risk');
      await finish(provider, ctx, payment);
    },
    async webhookFor(ctx, ref, at) {
      const w = fake.event(idOf(ctx), ctx.webhookSecret, ref, at);
      return { body: w.body, headers: w.headers };
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      const r = fake.dashboardRefund(idOf(ctx), payment.ref, amountMinor);
      return (await provider.retrieveRefund(ctx, { ref: r.id }))!;
    },
    async refundWebhookFor(ctx, refundRef, at) {
      const w = fake.event(idOf(ctx), ctx.webhookSecret, refundRef, at);
      return { body: w.body, headers: w.headers };
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials() {
      throw new Error('the local PayPal subject uses the fake: run the sandbox subject');
    },
  };
}

interface PwLocator { fill(v: string): Promise<void>; click(): Promise<void> }
interface PwPage { goto(url: string): Promise<unknown>; locator(s: string): PwLocator; getByRole(role: string, o: { name: RegExp }): PwLocator; waitForTimeout(ms: number): Promise<void> }
interface PwBrowser { newPage(): Promise<PwPage>; close(): Promise<void> }

/** A recorded real sandbox delivery: headers and the raw body, base64. */
interface RecordedDelivery { headers: Record<string, string>; bodyBase64: string }

/**
 * PayPal's sandbox. PayPal's signature cannot be made locally, so contract webhooks are signed with a test CA passed to
 * the same class; real signatures are checked on the recorded deliveries (a capture and a refund event), verified with
 * the default trust in the first context(): without them the run fails (plan 10, review Q5).
 */
export function paypalSandboxSubject(): ContractSubject {
  const env = process.env;
  const chain = paypalTestChain();
  const certUrl = `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-contract-${randomBytes(6).toString('hex')}`;
  const provider = new PayPalProvider({
    certificates: { roots: [chain.root.pem], leafNames: PAYPAL_LEAF_NAMES, fetch: async (url) => {
      if (url !== certUrl) throw new Error('paypal sandbox subject: not the contract certificate');
      return chain.chainPem;
    } },
  });
  let checkedRecorded = false;
  const api = async (ctx: ProviderContext, path: string): Promise<Record<string, unknown>> => {
    const tokenRes = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
      method: 'POST', body: 'grant_type=client_credentials',
      headers: { authorization: `Basic ${Buffer.from(`${ctx.credentials.clientId}:${ctx.credentials.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const res = await fetch(`https://api-m.sandbox.paypal.com${path}`, { headers: { authorization: `Bearer ${access_token}` } });
    if (!res.ok) throw new Error(`paypal sandbox: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const approve = async (orderId: string): Promise<void> => {
    // Not a dependency of the API: whoever runs the PayPal sandbox adds it first (docs/adding-a-payment-adapter.md).
    const moduleName = 'playwright';
    const { chromium } = (await import(moduleName)) as { chromium: { launch: (o: object) => Promise<PwBrowser> } };
    const browser = await chromium.launch({ channel: env.PW_CHANNEL || undefined });
    try {
      const page = await browser.newPage();
      await page.goto(`https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`);
      await page.locator('#email').fill(env.PAYPAL_SANDBOX_BUYER_EMAIL ?? '');
      await page.getByRole('button', { name: /next/i }).click();
      await page.locator('#password').fill(env.PAYPAL_SANDBOX_BUYER_PASSWORD ?? '');
      await page.getByRole('button', { name: /log in/i }).click();
      await page.waitForTimeout(5_000);
      await page.getByRole('button', { name: /pay|continue|complete/i }).click();
      await page.waitForTimeout(8_000);
    } finally {
      await browser.close();
    }
  };
  const signed = (ctx: ProviderContext, event: Record<string, unknown>, at: Date): SignedBody => {
    const body = Buffer.from(JSON.stringify(event));
    const transmissionId = randomUUID();
    const time = at.toISOString();
    return { body, headers: {
      'content-type': 'application/json', [PAYPAL_HEADERS.transmissionId]: transmissionId, [PAYPAL_HEADERS.transmissionTime]: time,
      [PAYPAL_HEADERS.transmissionSig]: sign('sha256', signedMessage(transmissionId, time, ctx.webhookSecret, body), chain.leaf.key).toString('base64'),
      [PAYPAL_HEADERS.certUrl]: certUrl, [PAYPAL_HEADERS.authAlgo]: 'SHA256withRSA',
    } };
  };
  const envelope = (type: string, resource: Record<string, unknown>, at: Date) => ({ id: `WH-CONTRACT-${randomBytes(8).toString('hex').toUpperCase()}`, event_version: '1.0', create_time: at.toISOString(), event_type: type, resource });
  const ctxOf = (): ProviderContext => ({
    accountId: randomUUID(), mode: 'test', credentials: { clientId: env.PAYPAL_SANDBOX_CLIENT_ID ?? '', clientSecret: env.PAYPAL_SANDBOX_CLIENT_SECRET ?? '' }, webhookSecret: env.PAYPAL_SANDBOX_WEBHOOK_ID ?? '',
  });
  async function checkRecorded(ctx: ProviderContext): Promise<void> {
    // Real PayPal signatures, with the registered class's default trust (Node's root store): A2, A3 and A4.
    const recorded = JSON.parse(readFileSync(env.PAYPAL_SANDBOX_RECORDED_DELIVERY!, 'utf8')) as RecordedDelivery[];
    const real = new PayPalProvider();
    const kinds = new Set<string>();
    for (const d of recorded) {
      const body = Buffer.from(d.bodyBase64, 'base64');
      await real.prepareWebhook(ctx, d.headers);
      const v = real.verifyWebhook(ctx, body, d.headers, new Date(d.headers[PAYPAL_HEADERS.transmissionTime]!));
      if (!v.ok) throw new Error(`paypal sandbox: a recorded delivery does not verify (${v.code})`);
      kinds.add(v.event.kind);
      if (v.event.kind === 'payment' && !v.event.payment?.ourPaymentId) throw new Error('paypal sandbox: the capture event carries no id of ours (A2)');
    }
    if (!kinds.has('payment') || !kinds.has('refund')) throw new Error('paypal sandbox: record one capture event and one refund event');
  }
  return {
    provider,
    async context() {
      const ctx = ctxOf();
      if (!checkedRecorded) {
        await checkRecorded(ctx);
        checkedRecorded = true;
      }
      return ctx;
    },
    badCredentials: unknownCredentials,
    async customerCompletes(ctx, payment, outcome) {
      if (outcome === 'decline') throw new Error('paypal sandbox: a declining sandbox buyer is set up by hand (negative testing); see the guide');
      await approve(payment.ref);
      const after = await finish(provider, ctx, payment);
      if (after.status !== 'succeeded') throw new Error('paypal sandbox: the payment was not collected');
    },
    async endAtGateway() {
      throw new Error('paypal sandbox: a risk-declined capture needs PayPal negative testing; see the guide');
    },
    async webhookFor(ctx, ref, at) {
      const order = await api(ctx, `/v2/checkout/orders/${ref}`);
      const units = order.purchase_units as Array<{ payments?: { captures?: Array<Record<string, unknown>> } }>;
      const cap = units[0]?.payments?.captures?.[0];
      return cap ? signed(ctx, envelope('PAYMENT.CAPTURE.COMPLETED', cap, at), at) : signed(ctx, envelope('CHECKOUT.ORDER.APPROVED', order, at), at);
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      // The dashboard is a person; the same refund through the API without our custom_id is the same to PayPal.
      const order = await api(ctx, `/v2/checkout/orders/${payment.ref}`);
      const cap = (order.purchase_units as Array<{ payments: { captures: Array<{ id: string }> } }>)[0]!.payments.captures[0]!;
      const tokenRes = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
        method: 'POST', body: 'grant_type=client_credentials',
        headers: { authorization: `Basic ${Buffer.from(`${ctx.credentials.clientId}:${ctx.credentials.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      });
      const { access_token } = (await tokenRes.json()) as { access_token: string };
      const res = await fetch(`https://api-m.sandbox.paypal.com/v2/payments/captures/${cap.id}/refund`, {
        method: 'POST', headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: { currency_code: 'AUD', value: `${amountMinor / 100n}.${(amountMinor % 100n).toString().padStart(2, '0')}` } }),
      });
      const r = (await res.json()) as { id: string };
      return (await provider.retrieveRefund(ctx, { ref: r.id }))!;
    },
    async refundWebhookFor(ctx, refundRef, at) {
      const refund = await api(ctx, `/v2/payments/refunds/${refundRef}`);
      return signed(ctx, envelope('PAYMENT.CAPTURE.REFUNDED', refund, at), at);
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials(e) {
      const shape = /^[A-Za-z0-9_-]{20,128}$/;
      if (!shape.test(e.PAYPAL_SANDBOX_CLIENT_ID ?? '') || !shape.test(e.PAYPAL_SANDBOX_CLIENT_SECRET ?? '')) throw new Error('test:sandbox paypal: PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET are missing');
      if (!/^[A-Z0-9]{10,32}$/.test(e.PAYPAL_SANDBOX_WEBHOOK_ID ?? '')) throw new Error('test:sandbox paypal: PAYPAL_SANDBOX_WEBHOOK_ID is missing');
      if (!e.PAYPAL_SANDBOX_BUYER_EMAIL || !e.PAYPAL_SANDBOX_BUYER_PASSWORD) throw new Error('test:sandbox paypal: the sandbox buyer is missing');
      if (!e.PAYPAL_SANDBOX_RECORDED_DELIVERY) throw new Error('test:sandbox paypal: PAYPAL_SANDBOX_RECORDED_DELIVERY (a capture and a refund delivery) is mandatory evidence');
    },
  };
}
