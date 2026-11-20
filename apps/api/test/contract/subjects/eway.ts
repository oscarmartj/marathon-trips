// The eWAY contract subjects (plan docs/plans/9.1-eway.md, sections 12 and 20 M7). Local: the registered
// CardSessionProvider over the eWAY gateway class against the in-process fake, with a store (memory by default; the
// database one in test/modules/payments/card-sessions.store.test.ts). Sandbox: the same classes against eWAY's sandbox,
// credentials from EWAY_SANDBOX_* variables; written and type-checked, never run here (no eWAY sandbox account): Secure
// Fields and the 3-D Secure challenge need a browser.
import { randomBytes, randomUUID } from 'node:crypto';
import { EwayGateway } from '../../../src/modules/payments/adapters/eway/eway';
import { MemoryCardSessionStore } from '../../../src/modules/payments/core/card-sessions/memory-store';
import { CardSessionProvider } from '../../../src/modules/payments/core/card-sessions/provider';
import type { CardPayer } from '../../../src/modules/payments/core/card-sessions/provider';
import type { CardSessionStore } from '../../../src/modules/payments/core/card-sessions/store';
import type { ProviderContext, ProviderPayment } from '../../../src/modules/payments/core/provider';
import { NO_GATEWAY_EVENT } from '../payment-provider.contract';
import type { ContractSubject } from '../payment-provider.contract';
import { FakeEway } from './eway-fake';
import type { CardOutcome } from './eway-fake';
import { CARD_PAGE_ORIGIN, expiringStore } from './pin';

export const EWAY_PAYER: CardPayer = { email: 'payer@example.test', ipAddress: '203.0.113.10', givenName: 'Contract', familyName: 'Payer', phone: '+61400000000' };
const keyOf = (ctx: ProviderContext) => ctx.credentials.apiKey!;
const idOf = (ref: string) => Number(ref.slice(4));

/** Well-formed credentials eWAY does not know: 401 everywhere. */
const unknownCredentials = (ctx: ProviderContext): ProviderContext => ({ ...ctx, credentials: { ...ctx.credentials, apiKey: `K${randomBytes(24).toString('hex')}` } });

export interface EwayLocalSubject extends ContractSubject {
  fake: FakeEway;
  provider: CardSessionProvider;
  store: CardSessionStore;
}

/**
 * The customer on eWAY's card page: Secure Fields give a code, our provider starts 3-D Secure, the bank's challenge is
 * passed in the page, then the page authorises (the one charge). Throws if the session takes no card.
 */
export async function payWithSecureFields(fake: FakeEway, provider: CardSessionProvider, ctx: ProviderContext, ref: string, outcome: CardOutcome, pass = true): Promise<void> {
  const code = fake.tokenise(ctx.credentials.publicApiKey!, outcome);
  const r = await provider.submitCard(ctx, ref, code, EWAY_PAYER);
  if (r.next.kind === 'not_open') throw new Error('fake eway: the session takes no card');
  if (r.next.kind !== 'authenticate') return;
  if (outcome !== 'pay_frictionless') fake.challenge(keyOf(ctx), r.next.authRef, pass);
  await provider.authoriseCard(ctx, ref, r.next.authRef, code, EWAY_PAYER.ipAddress);
}

export function ewayLocalSubject(fake = new FakeEway(), inner: CardSessionStore = new MemoryCardSessionStore(), contextFor?: (acc: ReturnType<FakeEway['newAccount']>) => Promise<ProviderContext>): EwayLocalSubject {
  const store = expiringStore(inner);
  const provider = new CardSessionProvider(new EwayGateway({ transport: fake.transport }), store, { cardPageOrigin: CARD_PAGE_ORIGIN, usable: true });
  const sessionOf = async (ctx: ProviderContext, ref: string) => {
    const s = await store.byRef(ctx.accountId, ref);
    if (!s) throw new Error('fake eway: no such session');
    return s;
  };
  return {
    fake,
    provider,
    store,
    async context() {
      const acc = fake.newAccount();
      if (contextFor) return contextFor(acc);
      return { accountId: randomUUID(), mode: 'test', credentials: { ...acc }, webhookSecret: randomBytes(32).toString('hex') };
    },
    badCredentials: unknownCredentials,
    async customerCompletes(ctx, payment: ProviderPayment, outcome) {
      await payWithSecureFields(fake, provider, ctx, payment.ref, outcome);
    },
    async endAtGateway(ctx, payment) {
      await sessionOf(ctx, payment.ref);
      store.expire(payment.ref);
    },
    async webhookFor() {
      // eWAY sends no events at all (plan 9.1, 4.2).
      return NO_GATEWAY_EVENT;
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      const s = await sessionOf(ctx, payment.ref);
      const id = fake.dashboardRefund(keyOf(ctx), idOf(s.chargeRef!), Number(amountMinor));
      return (await provider.retrieveRefund(ctx, { ref: `ewr_${id}` }))!;
    },
    async refundWebhookFor() {
      throw new Error('eWAY sends no events');
    },
    async loseNextAnswer(_ctx, kind) {
      fake.next.lose = kind;
    },
    async postCount(ctx, kind, paymentRef) {
      if (kind === 'charge') return fake.chargePosts(keyOf(ctx), paymentRef);
      const s = await sessionOf(ctx, paymentRef);
      return s.chargeRef ? fake.refundPosts(keyOf(ctx), idOf(s.chargeRef)) : 0;
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials() {
      throw new Error('the local eWAY subject uses the fake: run the sandbox subject');
    },
  };
}

const API_KEY = /^[A-Za-z0-9+/=]{20,200}$/;

/**
 * eWAY's sandbox (blocked: no sandbox account). Secure Fields and the 3-D Secure challenge run in a browser
 * (EWAY_SANDBOX_BROWSER_SCRIPT, to be written with Playwright when the account exists; plan 9.1, section 12). Amounts
 * ending in 00 approve and in 05 decline ("Use Cents Value"). No recorded deliveries: eWAY sends none.
 */
export function ewaySandboxSubject(): ContractSubject {
  const env = process.env;
  const store = expiringStore(new MemoryCardSessionStore());
  const provider = new CardSessionProvider(new EwayGateway(), store, { cardPageOrigin: 'https://localhost.invalid', usable: true });
  const browser = (): never => {
    throw new Error('eway sandbox: Secure Fields and 3-D Secure need a browser; see the guide (EWAY_SANDBOX_BROWSER_SCRIPT)');
  };
  return {
    provider,
    async context() {
      return {
        accountId: randomUUID(), mode: 'test',
        credentials: { apiKey: env.EWAY_SANDBOX_API_KEY ?? '', apiPassword: env.EWAY_SANDBOX_API_PASSWORD ?? '', publicApiKey: env.EWAY_SANDBOX_PUBLIC_KEY ?? '' },
        webhookSecret: randomBytes(32).toString('hex'),
      };
    },
    badCredentials: unknownCredentials,
    async customerCompletes() {
      browser();
    },
    async endAtGateway(ctx, payment) {
      store.expire(payment.ref);
    },
    async webhookFor() {
      return NO_GATEWAY_EVENT;
    },
    async gatewayRefunds() {
      return browser();
    },
    async refundWebhookFor() {
      throw new Error('eWAY sends no events');
    },
    async loseNextAnswer() {
      // A real gateway's answer cannot be lost on purpose: the sandbox run drops the connection in the browser script.
      browser();
    },
    async postCount() {
      return browser();
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials(e) {
      if (!API_KEY.test(e.EWAY_SANDBOX_API_KEY ?? '')) throw new Error('eway sandbox: EWAY_SANDBOX_API_KEY is not set or has no key shape');
      if (!/^[A-Za-z0-9!#$%&*+./=?@^_~-]{8,64}$/.test(e.EWAY_SANDBOX_API_PASSWORD ?? '')) throw new Error('eway sandbox: EWAY_SANDBOX_API_PASSWORD is not set');
      if (!/^epk-[A-Za-z0-9-]{20,60}$/.test(e.EWAY_SANDBOX_PUBLIC_KEY ?? '')) throw new Error('eway sandbox: EWAY_SANDBOX_PUBLIC_KEY is not set or has no key shape');
      if (!e.EWAY_SANDBOX_BROWSER_SCRIPT) throw new Error('eway sandbox: EWAY_SANDBOX_BROWSER_SCRIPT (Secure Fields and 3-D Secure in a browser) is required');
    },
  };
}
