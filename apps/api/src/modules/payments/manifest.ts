import type { PermissionDef } from '../../platform/access/permissions';
import { PAYMENT_EVENTS } from './core/attempt-state';

// Permissions follow <module>.<resource>.<action> (plan 0.1, 1.5). Neither is an API key scope: they expose customers'
// payments and gateway accounts (plan 3.1, section 7). No 3.1 route changes credentials or confirms money, so none needs
// step-up; payments.providerAccount.manageCredentials (with step-up) arrives with its route in 4.1.
export const PAYMENTS_PERMISSIONS = {
  paymentRead: 'payments.payment.read',
  accountRead: 'payments.providerAccount.read',
} as const;

const def = (key: string, description: string): PermissionDef => ({ key, module: 'payments', description, requiresStepUp: false, apiKeyScopable: false });

export const paymentsManifest = {
  key: 'payments',
  /** payments has no feature flag: switching it off would leave payments half-done (plan 0.1, 9.12). */
  flagKey: null,
  permissions: [
    def(PAYMENTS_PERMISSIONS.paymentRead, "See a booking's payment plan, payment attempts and gateway events (never card data or raw bodies)"),
    def(PAYMENTS_PERMISSIONS.accountRead, 'See payment gateway accounts and their adapter status (never credentials)'),
  ] satisfies PermissionDef[],
  publishes: Object.values(PAYMENT_EVENTS),
  subscribes: [] as string[],
} as const;
