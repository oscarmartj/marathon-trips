// Every payment adapter in the code, one line each (plan 3.1, section 2.3). A new gateway is a folder under adapters/
// and a line here; its status lives in its manifest and only changes in a reviewed PR.
import type { PaymentProvider } from '../core/provider';
import { SimulatorProvider } from './simulator/simulator';

export const ADAPTERS: readonly PaymentProvider[] = [new SimulatorProvider()];
