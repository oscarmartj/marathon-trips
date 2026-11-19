import type { PermissionDef } from '../../platform/access/permissions';
import { PAYMENT_EVENTS } from './core/attempt-state';

// Permissions follow <module>.<resource>.<action> (plan 0.1, 1.5). Neither is an API key scope: they expose customers'
// payments and gateway accounts (plan 3.1, section 7). Managing gateway accounts and their credentials needs step-up
// (task 4.1; plan 0.1, 4.2 lists "cuentas y credenciales de pasarela").
export const PAYMENTS_PERMISSIONS = {
  paymentRead: 'payments.payment.read',
  accountRead: 'payments.providerAccount.read',
  accountManage: 'payments.providerAccount.manage',
  accountManageCredentials: 'payments.providerAccount.manageCredentials',
  routingRuleManage: 'payments.routingRule.manage',
  paymentLinkSend: 'payments.paymentLink.send',
  methodRead: 'payments.method.read',
  methodManage: 'payments.method.manage',
  confirmTransfer: 'payments.payment.confirmTransfer',
  voidTransfer: 'payments.payment.void',
  // Task 4.5: refunds from the app and disputes.
  refundRequest: 'payments.refund.request',
  refundConfirmManual: 'payments.refund.confirmManual',
  disputeManage: 'payments.dispute.manage',
  disputeEvidence: 'payments.dispute.evidence',
} as const;

const def = (key: string, description: string, requiresStepUp = false): PermissionDef => ({ key, module: 'payments', description, requiresStepUp, apiKeyScopable: false });

export const paymentsManifest = {
  key: 'payments',
  /** payments has no feature flag: switching it off would leave payments half-done (plan 0.1, 9.12). */
  flagKey: null,
  permissions: [
    def(PAYMENTS_PERMISSIONS.paymentRead, "See a booking's payment plan, payment attempts and gateway events (never card data or raw bodies)"),
    def(PAYMENTS_PERMISSIONS.accountRead, 'See payment gateway accounts and their adapter status (never credentials)'),
    // Task 4.1: what an account offers and to whom, and its secrets; step-up on both.
    def(PAYMENTS_PERMISSIONS.accountManage, 'Rename a payment gateway account, pause, activate, retire or archive it, and run its connection test', true),
    def(PAYMENTS_PERMISSIONS.accountManageCredentials, "Create a payment gateway account and change its credentials, webhook secret or webhook address (never shown again once saved)", true),
    // Task 4.2: which account takes which payments, and its backups; step-up.
    def(PAYMENTS_PERMISSIONS.routingRuleManage, 'Create, change and remove payment routing rules: which gateway account takes each method, country, currency and amount, in what order, and which account backs up which', true),
    def(PAYMENTS_PERMISSIONS.paymentLinkSend, "Email a customer a single-use link to pay the next item of their booking's plan, and revoke such links"),
    def(PAYMENTS_PERMISSIONS.methodRead, 'See how the manual payment methods (bank transfer, PayID) are set up, including the business payee details'),
    // Money moves (or is taken back) on these, and the payee details tell customers where to send it: step-up (task 3.4).
    def(PAYMENTS_PERMISSIONS.methodManage, 'Switch a manual payment method on or off and change its countries, instructions and payee details', true),
    def(PAYMENTS_PERMISSIONS.confirmTransfer, 'Record a bank transfer that arrived (the amount and the bank reference) and apply it to the booking', true),
    def(PAYMENTS_PERMISSIONS.voidTransfer, 'Void a bank transfer that was recorded by mistake (it can then be recorded again)', true),
    // Task 4.5: money goes back to a customer, or a copy of their data leaves the app: step-up.
    def(PAYMENTS_PERMISSIONS.refundRequest, "Refund what a payment holds beyond what its booking owes (the amount comes from the app), and settle a refund the gateway did not answer", true),
    def(PAYMENTS_PERMISSIONS.refundConfirmManual, 'Record where a bank transfer refund goes, see it, and confirm it was sent (with the bank reference) or cancel it', true),
    def(PAYMENTS_PERMISSIONS.disputeManage, 'Record that the evidence for a payment dispute was submitted at the gateway'),
    def(PAYMENTS_PERMISSIONS.disputeEvidence, "Download a dispute's evidence package (terms accepted, booking snapshots, payments and emails sent)", true),
  ] satisfies PermissionDef[],
  publishes: Object.values(PAYMENT_EVENTS),
  subscribes: [] as string[],
} as const;
