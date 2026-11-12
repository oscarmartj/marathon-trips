// Every payment adapter in the code, one line each (plan 3.1, section 2.3). A new gateway is a folder under adapters/,
// a line here and its contract subjects in test/contract/subjects/ (plan 3.6); its status lives in its manifest and
// only changes in a reviewed PR. Options are passed in by the payments module: an adapter reads no environment.
import type { PaymentProvider } from '../core/provider';
import { SimulatorProvider } from './simulator/simulator';

export interface AdapterOptions {
  /** WEB_ORIGIN: where the simulator's hosted checkout page is served (development, test and ci only). */
  webOrigin: string;
}

export function createAdapters(opts: AdapterOptions): PaymentProvider[] {
  return [new SimulatorProvider({ webOrigin: opts.webOrigin })];
}
