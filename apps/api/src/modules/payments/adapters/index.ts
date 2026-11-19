// Every payment adapter in the code, one line each (plan 3.1, section 2.3). A new gateway is a folder under adapters/,
// a line here and its contract subjects in test/contract/subjects/ (plan 3.6); its status lives in its manifest and
// only changes in a reviewed PR. Options are passed in by the payments module: an adapter reads no environment.
import type { AppEnv } from '@mt/shared';
import { TEST_ADAPTER_ENVS } from '../core/gateway';
import type { PaymentProvider } from '../core/provider';
import { SimulatorProvider } from './simulator/simulator';
import { StripeProvider } from './stripe/stripe';

export interface AdapterOptions {
  /** Where the simulator's hosted checkout page is served: WEB_ORIGIN in development, test and ci. */
  webOrigin: string;
}

/**
 * Outside development, test and ci the simulator never runs (the gateway wrapper refuses it), so its page origin is
 * a fixed, inert one there: starting the API in staging or production never depends on the shape of WEB_ORIGIN.
 */
export const INERT_SIMULATOR_ORIGIN = 'https://checkout.simulator.invalid';

export function adapterOptions(env: AppEnv, webOrigin: string): AdapterOptions {
  return { webOrigin: TEST_ADAPTER_ENVS.includes(env) ? webOrigin : INERT_SIMULATOR_ORIGIN };
}

export function createAdapters(opts: AdapterOptions): PaymentProvider[] {
  // Stripe is experimental (task 3.3): the gateway wrapper never lets it charge live, and it has no account unless one
  // is created with `payments:stripe-test-account`.
  return [new SimulatorProvider({ webOrigin: opts.webOrigin }), new StripeProvider()];
}
