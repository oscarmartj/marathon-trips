// Planned gateways (task 4.2, plan docs/plans/4.2-routing-rules.md, section 7): catalogue entries only, from the order
// of docs/research/payment-providers.md, section 4. No code talks to them, no account or rule can point at them, and
// the panel shows them as `planned`. When a real adapter lands (4.3, 4.4, phase 9), its entry is deleted here: a test
// fails if a planned key is also a registered adapter.
import type { PaymentMethod } from '@mt/shared';

export interface PlannedAdapter {
  key: string;
  displayName: string;
  methods: readonly PaymentMethod[];
  currencies: readonly string[];
  countries: readonly string[] | 'any';
}

export const PLANNED_ADAPTERS: readonly PlannedAdapter[] = [
  { key: 'pin_payments', displayName: 'Pin Payments', methods: ['card', 'apple_pay', 'google_pay'], currencies: ['AUD'], countries: 'any' },
  { key: 'eway', displayName: 'eWAY', methods: ['card'], currencies: ['AUD'], countries: 'any' },
  { key: 'paypal', displayName: 'PayPal', methods: ['card'], currencies: ['AUD'], countries: 'any' },
  { key: 'westpac_onlinepay', displayName: 'Westpac OnlinePay', methods: ['card'], currencies: ['AUD'], countries: 'any' },
  { key: 'gocardless', displayName: 'GoCardless', methods: ['payto', 'becs'], currencies: ['AUD'], countries: ['AU'] },
  { key: 'azupay', displayName: 'Azupay', methods: ['payto', 'payid_transfer'], currencies: ['AUD'], countries: ['AU'] },
];
