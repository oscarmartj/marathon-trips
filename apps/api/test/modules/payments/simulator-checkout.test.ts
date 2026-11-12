// The simulator's hosted checkout through HTTP, the real webhook ingestion and PostgreSQL
// (plan docs/plans/3.6-adapter-contract-suite.md, sections 3, 5 and 10).
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_ENVS } from '@mt/shared';
import { SIMULATOR_CHECKOUT_PATH, SimulatorProvider, SimulatorWorld } from '../../../src/modules/payments/adapters/simulator/simulator';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { ProviderError } from '../../../src/modules/payments/core/provider';
import { PaymentWebhooksService } from '../../../src/modules/payments/core/webhooks.service';
import { CHECKOUT_PAGE_CSP, checkoutPage, escapeHtml, formatMinor } from '../../../src/modules/payments/simulator-checkout/checkout.page';
import { SimulatorCheckoutController, SimulatorCheckoutService, simulatorCheckoutControllers } from '../../../src/modules/payments/simulator-checkout/checkout.controller';
import { TestApp, WEB_ORIGIN, makeApp } from '../../support/auth';
import { cleanBookingEvents } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { pricedWorld } from '../../support/pricing';
import { allRoutes } from '../../support/routes';
import { PayingCustomer, SimAccount, approvedBooking, cleanPayments, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount } from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const PREFIX = `${WEB_ORIGIN}${SIMULATOR_CHECKOUT_PATH}/`;
const statusOf = async (id: string) => (await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const paymentsOf = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
const eventsOfAccount = () => t.prisma.webhookEvent.count({ where: { providerAccountId: acc.id } });
const rejectionsOfAccount = () => t.prisma.webhookRejection.count({ where: { providerAccountId: acc.id } });
/** The API path behind the web's /api proxy for a redirect URL the API handed out. */
const apiPath = (url: string) => url.slice(`${WEB_ORIGIN}/api`.length);
const html = (res: { text: string }) => res.text;

/** An approved booking of customer c on a package without auto-confirmation, and its first attempt's redirect. */
async function started(): Promise<{ bookingId: string; reference: string; url: string; token: string; paymentId: string; ref: string }> {
  const w = await pricedWorld(admin);
  await t.prisma.$executeRawUnsafe(`UPDATE packages SET "autoConfirmOnDeposit" = false WHERE id = $1::uuid`, w.pkg.id);
  const { bookingId, reference } = await approvedBooking(t, admin, w, c);
  const res = await c.pay(reference, { method: 'card' });
  expect(res.status).toBe(201);
  const url = res.body.nextAction.url as string;
  const [p] = await paymentsOf(bookingId);
  return { bookingId, reference, url, token: url.slice(PREFIX.length), paymentId: p!.id, ref: p!.providerPaymentRef! };
}

const submit = (url: string, body: string) => t.http().post(apiPath(url)).type('form').send(body);

/** The ids of this account's stored events, to tell the new ones apart. */
const eventIds = async () => new Set((await t.prisma.webhookEvent.findMany({ where: { providerAccountId: acc.id }, select: { id: true } })).map((e) => e.id));

/** Runs, as the worker would, the jobs of the events stored since `before` (a snapshot of eventIds()). */
async function processNewEvents(before: Set<string>): Promise<string[]> {
  const evs = (await t.prisma.webhookEvent.findMany({ where: { providerAccountId: acc.id }, orderBy: { receivedAt: 'asc' } })).filter((e) => !before.has(e.id));
  const svc = t.app.get(PaymentWebhooksService);
  const out: string[] = [];
  for (const ev of evs) out.push(await svc.process(ev.id));
  return out;
}

describe('the hosted checkout page (plan 3.6, section 3)', () => {
  it('checkout_pay_end_to_end: redirect, page, pay, signed webhook through the real ingestion, booking deposit_paid', async () => {
    const s = await started();
    expect(s.url.startsWith(PREFIX)).toBe(true);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: s.bookingId } });
    const page = await t.http().get(apiPath(s.url));
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(html(page)).toContain(formatMinor(b.depositMinor, 'AUD'));
    expect(html(page)).toContain('value="pay"');
    const rejections = await rejectionsOfAccount();
    const before = await eventIds();
    const res = await submit(s.url, 'outcome=pay');
    expect(res.status).toBe(200);
    expect(html(res)).toContain('Payment approved');
    expect(html(res)).not.toContain('<form');
    const stored = (await t.prisma.webhookEvent.findMany({ where: { providerAccountId: acc.id } })).filter((e) => !before.has(e.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'received', type: 'payment.updated' });
    expect(await rejectionsOfAccount()).toBe(rejections);
    expect(await processNewEvents(before)).toEqual(['processed']);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).status).toBe('succeeded');
    expect(await statusOf(s.bookingId)).toBe('deposit_paid');
  });

  it('checkout_decline_marks_failed_and_allows_new_attempt', async () => {
    const s = await started();
    const before = await eventIds();
    const res = await submit(s.url, 'outcome=decline');
    expect(res.status).toBe(200);
    expect(html(res)).toContain('Payment declined');
    expect(await processNewEvents(before)).toEqual(['processed']);
    expect(await t.prisma.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).toMatchObject({ status: 'failed', failureCode: 'card_declined' });
    expect(await statusOf(s.bookingId)).toBe('approved');
    const again = await c.pay(s.reference, { method: 'card' });
    expect(again.status).toBe(201);
    expect((await paymentsOf(s.bookingId)).map((p) => [p.attemptNumber, p.status])).toEqual([[1, 'failed'], [2, 'requires_action']]);
    expect(again.body.nextAction.url).not.toBe(s.url);
  });

  it('checkout_back_link_changes_nothing: the link goes to the return page and nothing moves', async () => {
    const s = await started();
    const events = await eventsOfAccount();
    const page = html(await t.http().get(apiPath(s.url)));
    expect(page).toContain(`<a href="${escapeHtml(`${WEB_ORIGIN}/payments/return`)}" rel="noreferrer">Back to the site</a>`);
    expect(sim.find(acc.id, { ref: s.ref })?.status).toBe('requires_action');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).status).toBe('requires_action');
    expect(await eventsOfAccount()).toBe(events);
  });

  it('checkout_double_submit_settles_once: two submissions at once, one change and one webhook', async () => {
    const s = await started();
    const events = await eventsOfAccount();
    const [a, b] = await Promise.all([submit(s.url, 'outcome=pay'), submit(s.url, 'outcome=decline')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const pages = [html(a), html(b)];
    expect(pages.filter((p) => p.includes('This payment is already finished'))).toHaveLength(1);
    expect(pages.filter((p) => p.includes('Payment approved') || p.includes('Payment declined'))).toHaveLength(1);
    expect(await eventsOfAccount()).toBe(events + 1);
    expect(['succeeded', 'failed']).toContain(sim.find(acc.id, { ref: s.ref })?.status);
    // And later: the page says it is finished, and a third submission changes nothing.
    expect(html(await t.http().get(apiPath(s.url)))).toContain('This payment is already finished');
    expect(html(await submit(s.url, 'outcome=pay'))).toContain('This payment is already finished');
    expect(await eventsOfAccount()).toBe(events + 1);
  });

  it('checkout_cancelled_attempt_cannot_be_paid', async () => {
    const s = await started();
    const cancelled = await t.app.get(ProviderGateway).call(acc.id, 'cancel', (p, ctx) => p.cancelPayment(ctx, s.ref, `test-cancel:${s.ref}`));
    expect(cancelled.status).toBe('cancelled');
    const events = await eventsOfAccount();
    const res = await submit(s.url, 'outcome=pay');
    expect(res.status).toBe(200);
    expect(html(res)).toContain('This payment is already finished');
    expect(sim.find(acc.id, { ref: s.ref })?.status).toBe('cancelled');
    expect(await eventsOfAccount()).toBe(events);
  });

  it('checkout_unknown_or_malformed_token_404: exactly what a route that does not exist answers', async () => {
    const missing = await t.http().get(`/payments/no-such-route/${randomBytes(32).toString('base64url')}`);
    expect(missing.status).toBe(404);
    const unknown = randomBytes(32).toString('base64url');
    for (const res of [
      await t.http().get(`/payments/simulator/checkout/${unknown}`),
      await t.http().post(`/payments/simulator/checkout/${unknown}`).type('form').send('outcome=pay'),
      await t.http().get('/payments/simulator/checkout/short'),
      await t.http().post('/payments/simulator/checkout/short').type('form').send('outcome=pay'),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
      expect(res.headers['content-type']).toBe(missing.headers['content-type']);
    }
  });

  it('checkout_body_strict: only `outcome`, and only pay or decline (422 otherwise)', async () => {
    const s = await started();
    const events = await eventsOfAccount();
    for (const body of ['outcome=pay&amountMinor=1', 'outcome=pay&ref=sim_pay_x', 'outcome=refund', '', 'outcome=pay&cardNumber=4242424242424242']) {
      const res = await submit(s.url, body);
      expect(res.status, body).toBe(422);
    }
    expect((await t.http().post(apiPath(s.url)).send({ outcome: 'pay', amountMinor: '1' })).status).toBe(422);
    expect(sim.find(acc.id, { ref: s.ref })?.status).toBe('requires_action');
    expect(await eventsOfAccount()).toBe(events);
  });

  it('checkout_delivery_failure_recovered_by_resume: the page still answers, the customer resumes and the payment is recorded', async () => {
    const s = await started();
    const svc = t.app.get(PaymentWebhooksService);
    const spy = vi.spyOn(svc, 'receiveForAccountId').mockRejectedValueOnce(Object.assign(new Error('database down'), { code: 'unexpected_error' }));
    const events = await eventsOfAccount();
    try {
      const res = await submit(s.url, 'outcome=pay');
      expect(res.status).toBe(200);
      expect(html(res)).toContain('Payment approved');
    } finally {
      spy.mockRestore();
    }
    expect(await eventsOfAccount()).toBe(events);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).status).toBe('requires_action');
    const resumed = await c.pay(s.reference, { method: 'card' });
    expect(resumed.status).toBeLessThan(300);
    expect(resumed.body.status).toBe('succeeded');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).status).toBe('succeeded');
    expect(await statusOf(s.bookingId)).toBe('deposit_paid');
  });

  it('checkout_token_never_logged: not by the API, whatever happens', async () => {
    const s = await started();
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(capture)),
      ...(['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(capture)),
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; }),
    ];
    const fail = vi.spyOn(t.app.get(PaymentWebhooksService), 'receiveForAccountId').mockRejectedValueOnce(new Error(`boom ${s.token}`));
    const unknown = randomBytes(32).toString('base64url');
    try {
      await t.http().get(apiPath(s.url));
      await submit(s.url, 'outcome=bogus');
      await submit(s.url, 'outcome=pay');
      await t.http().get(`/payments/simulator/checkout/${unknown}`);
    } finally {
      fail.mockRestore();
      for (const sp of spies) sp.mockRestore();
    }
    expect(lines.join('\n')).toContain('webhook delivery failed');
    expect(lines.join('\n')).not.toContain(s.token);
    expect(lines.join('\n')).not.toContain(unknown);
  });
});

describe('only in development, test and ci (plan 3.6, 10.6)', () => {
  it('checkout_404_outside_test_envs: not registered, and answering 404 if it were', async () => {
    for (const env of APP_ENVS) expect(simulatorCheckoutControllers(env), env).toEqual(['development', 'test', 'ci'].includes(env) ? [SimulatorCheckoutController] : []);
    expect(simulatorCheckoutControllers(undefined)).toEqual([]);
    expect(simulatorCheckoutControllers('prod')).toEqual([]);
    // Registered here (test).
    expect(allRoutes(t.app).filter((r) => r.controller === 'SimulatorCheckoutController').map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /payments/simulator/checkout/:token', 'POST /payments/simulator/checkout/:token']);
    // The service itself refuses outside the list, before anything moves, with a live token.
    const s = await started();
    const gateway = t.app.get(ProviderGateway);
    const webhooks = t.app.get(PaymentWebhooksService);
    for (const env of APP_ENVS.filter((e) => !['development', 'test', 'ci'].includes(e))) {
      const svc = new SimulatorCheckoutService(gateway, webhooks, { ...t.config, APP_ENV: env });
      expect(() => svc.page(s.token), env).toThrow(expect.objectContaining({ status: 404 }));
      await expect(svc.submit(s.token, 'pay'), env).rejects.toMatchObject({ status: 404 });
    }
    expect(sim.find(acc.id, { ref: s.ref })?.status).toBe('requires_action');
  });

  it('csrf_exempt_routes_are_exactly_webhook_and_simulator_checkout (method only, never a class)', () => {
    const reflector = new Reflector();
    const routes = allRoutes(t.app);
    const classes = new Set(routes.map((r) => r.controllerClass));
    for (const cls of classes) expect(reflector.get('csrf-exempt', cls), cls.name).toBeUndefined();
    const exempt = routes.filter((r) => reflector.get('csrf-exempt', (r.controllerClass.prototype as Record<string, unknown>)[r.handler] as () => void)).map((r) => `${r.method} ${r.path}`).sort();
    expect(exempt).toEqual(['POST /payments/simulator/checkout/:token', 'POST /payments/webhooks/:pathToken']);
  });
});

describe('the page itself (plan 3.6, 10.1)', () => {
  const proxy = readFileSync(resolve(__dirname, '../../../../web/src/lib/api-proxy.ts'), 'utf8');
  const forwarded = JSON.parse(/FORWARD_RESPONSE_HEADERS = (\[[^\]]*\])/.exec(proxy)![1]!.replace(/'/g, '"')) as string[];
  const segment = new RegExp(/const SEGMENT = \/(.+)\/;/.exec(proxy)![1]!);

  it('checkout_page_safe_through_web_proxy: its policy travels in the HTML, not in headers the proxy drops', async () => {
    const s = await started();
    const res = await t.http().get(apiPath(s.url));
    const through = Object.keys(res.headers).filter((h) => forwarded.includes(h));
    expect(through).toContain('content-type');
    expect(forwarded).not.toContain('content-security-policy');
    expect(forwarded).not.toContain('referrer-policy');
    const page = html(res);
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CHECKOUT_PAGE_CSP)}">`);
    expect(CHECKOUT_PAGE_CSP).toBe("default-src 'none'; form-action 'self'; base-uri 'none'");
    expect(page).toContain('<meta name="referrer" content="no-referrer">');
    expect(page).toMatch(/<a [^>]*rel="noreferrer"/);
    expect(page.indexOf('<meta http-equiv="Content-Security-Policy"')).toBeLessThan(page.indexOf('<body>'));
  });

  it('checkout_page_has_no_card_fields: no input, script or style; values escaped', () => {
    for (const state of ['open', 'paid', 'declined', 'finished'] as const) {
      const page = checkoutPage(state, { amountMinor: 12345n, currency: 'AUD' }, 'https://x.test/r?a=1&b="><script>alert(1)</script>');
      expect(page).not.toMatch(/<input|<script|<style|style=|<textarea|<select|<iframe/i);
      expect(page).toContain('https://x.test/r?a=1&amp;b=&quot;&gt;&lt;script&gt;');
      expect(/<form/.test(page)).toBe(state === 'open');
    }
  });

  it('formatMinor: from bigint, with the currency digits', () => {
    expect(formatMinor(0n, 'AUD')).toBe('AUD 0.00');
    expect(formatMinor(5n, 'AUD')).toBe('AUD 0.05');
    expect(formatMinor(123456789n, 'AUD')).toBe('AUD 1,234,567.89');
    expect(formatMinor(1500n, 'JPY')).toBe('JPY 1,500');
    expect(formatMinor(9007199254740993n, 'AUD')).toBe('AUD 90,071,992,547,409.93');
  });

  it('checkout_url_survives_web_proxy_shape: every segment passes the proxy', async () => {
    const s = await started();
    const segments = s.url.slice(`${WEB_ORIGIN}/api/`.length).split('/');
    expect(segments).toEqual(['payments', 'simulator', 'checkout', s.token]);
    for (const seg of segments) expect(segment.test(seg), seg).toBe(true);
  });

  it('completeCheckout refuses a token of another account', async () => {
    const world = new SimulatorWorld();
    const provider = new SimulatorProvider({ webOrigin: WEB_ORIGIN }, world);
    const ctx = (accountId: string) => ({ accountId, mode: 'test' as const, credentials: { apiKey: `sim_test_${randomBytes(12).toString('hex')}` }, webhookSecret: randomBytes(32).toString('hex') });
    const a = ctx(randomUUID());
    const p = await provider.createPayment(a, { amount: { amountMinor: 100n, currency: 'AUD' }, method: 'card', idempotencyKey: 'k', metadata: { paymentId: randomUUID(), bookingId: randomUUID() }, returnUrl: `${WEB_ORIGIN}/payments/return`, customerCountry: 'AU' });
    const token = p.nextAction!.url.split('/').pop()!;
    expect(() => provider.completeCheckout(ctx(randomUUID()), token, 'pay')).toThrow(ProviderError);
    expect((await provider.retrievePayment(a, { ref: p.ref }))?.status).toBe('requires_action');
    expect(provider.completeCheckout(a, token, 'pay').changed).toBe(true);
  });
});
