// Every payment adapter in the code, one line each (plan 3.1, section 2.3). A new gateway is a folder under adapters/,
// a line here and its contract subjects in test/contract/subjects/ (plan 3.6); its status lives in its manifest and
// only changes in a reviewed PR. Options are passed in by the payments module: an adapter reads no environment.
import type { AppEnv } from '@mt/shared';
import { TEST_ADAPTER_ENVS } from '../core/gateway';
import { CardSessionProvider } from '../core/card-sessions/provider';
import type { CardSessionStore } from '../core/card-sessions/store';
import { unwiredCardSessionStore } from '../core/card-sessions/store';
import type { PaymentProvider } from '../core/provider';
import { EwayGateway } from './eway/eway';
import { PayPalProvider } from './paypal/paypal';
import { PinPaymentsGateway } from './pin_payments/pin';
import { SimulatorProvider } from './simulator/simulator';
import { StripeProvider } from './stripe/stripe';

export interface AdapterOptions {
  /** Where the simulator's hosted checkout page is served: WEB_ORIGIN in development, test and ci. */
  webOrigin: string;
  /**
   * Task 4.4: where our own card page is served (Pin Payments' hosted fields). WEB_ORIGIN in development, test and ci;
   * elsewhere WEB_ORIGIN only when it is a plain https origin, else an inert one (no card session is then created).
   */
  cardPageOrigin?: string;
  /** Task 4.4: the database store of card sessions; absent for registries built for static checks. */
  cardSessions?: CardSessionStore;
}

/** The card page origin outside test environments when WEB_ORIGIN is not a plain https origin. */
export const INERT_CARD_PAGE_ORIGIN = 'https://card-page.invalid';
const PLAIN_HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+$/;

/**
 * Outside development, test and ci the simulator never runs (the gateway wrapper refuses it), so its page origin is
 * a fixed, inert one there: starting the API in staging or production never depends on the shape of WEB_ORIGIN.
 */
export const INERT_SIMULATOR_ORIGIN = 'https://checkout.simulator.invalid';

export function adapterOptions(env: AppEnv, webOrigin: string, cardSessions?: CardSessionStore): AdapterOptions {
  const testEnv = TEST_ADAPTER_ENVS.includes(env);
  const cardPageOrigin = testEnv || PLAIN_HTTPS_ORIGIN.test(webOrigin) ? webOrigin : INERT_CARD_PAGE_ORIGIN;
  return { webOrigin: testEnv ? webOrigin : INERT_SIMULATOR_ORIGIN, cardPageOrigin, ...(cardSessions ? { cardSessions } : {}) };
}

export function createAdapters(opts: AdapterOptions): PaymentProvider[] {
  // Stripe is experimental (task 3.3): the gateway wrapper never lets it charge live, and it has no account unless one
  // is created with `payments:stripe-test-account`.
  // PayPal is experimental too (task 4.3): test accounts only reach PayPal's sandbox.
  // Pin Payments is experimental too (task 4.4): its card is typed into Pin's iframes on our card page, so the core's
  // CardSessionProvider holds the session before the card is submitted; test accounts only reach test-api.pinpayments.com.
  const cardPageOrigin = opts.cardPageOrigin ?? opts.webOrigin;
  const pin = new CardSessionProvider(new PinPaymentsGateway(), opts.cardSessions ?? unwiredCardSessionStore(), { cardPageOrigin, usable: cardPageOrigin !== INERT_CARD_PAGE_ORIGIN });
  // eWAY is experimental too (task 9.1): Secure Fields on our page, 3-D Secure before the one charge, and no events, so
  // every state is read from eWAY; it cannot become verified without reconciliation and disputes (registry).
  const eway = new CardSessionProvider(new EwayGateway(), opts.cardSessions ?? unwiredCardSessionStore(), { cardPageOrigin, usable: cardPageOrigin !== INERT_CARD_PAGE_ORIGIN });
  return [new SimulatorProvider({ webOrigin: opts.webOrigin }), new StripeProvider(), new PayPalProvider(), pin, eway];
}
