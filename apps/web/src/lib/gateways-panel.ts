// The "Payment gateways" admin page (task 4.1): what the page shows for each account and warning. Pure, so it is
// tested without a browser. The API decides everything (what may change, what is lost, what passed); the page never
// holds a credential after a request ends and never shows one.
import { t } from './i18n-admin';

export type AccountStatus = 'active' | 'paused' | 'retired' | 'archived';

export interface AdapterView {
  key: string;
  displayName: string;
  status: 'verified' | 'experimental' | 'planned';
  testOnly: boolean;
  methods: string[];
  currencies: string[];
  credentialFields: Array<{ key: string; label: string }>;
  webhookSecret: { source: 'entered'; label: string } | { source: 'generated' };
  creatable: boolean;
  creatableReason: string | null;
  /** Task 9.1: what the adapter can do, from its manifest; null for a planned entry. */
  capabilities?: AdapterCapabilities | null;
}

export interface AdapterCapabilities {
  refunds: 'none' | 'full' | 'partial';
  deferredCapture: boolean;
  disputes: boolean;
  reconciliation: { activity: boolean; settlements: boolean } | null;
  gatewayEvents: 'signed' | 'none';
  cardEntry: 'gateway_page' | 'card_fields' | 'simulated' | 'manual';
}

export interface AccountView {
  id: string;
  adapterKey: string;
  displayName: string;
  mode: 'test' | 'live';
  status: AccountStatus;
  version: number;
  pauseReasonCode: string | null;
  lastConnectionTestAt: string | null;
  lastConnectionTestResult: string | null;
  connectionTestCurrent: boolean;
  webhookSecretSet: boolean;
  lastWebhookReceivedAt: string | null;
  lastWebhookRejection: { at: string; reason: string } | null;
  adapterStatus: string;
  allowedTransitions: AccountStatus[];
}

export type Warning = { code: string; accountId?: string; country?: string; reason?: string };

const KNOWN_RESULTS = new Set([
  'ok', 'provider_unavailable', 'provider_timeout', 'provider_busy', 'provider_rejected', 'provider_auth_failed', 'provider_not_found',
  'webhook_secret_missing', 'manual_instructions_invalid', 'credentials_unreadable',
]);
const KNOWN_WARNINGS = new Set(['no_method_for_country', 'active_without_current_test', 'paused_by_system', 'webhook_rejected_since_change', 'webhook_secret_missing', 'adapter_missing', 'adapter_planned_with_account']);
const KNOWN_REASONS = new Set(['live_mode_not_available', 'adapter_unknown', 'adapter_unavailable', 'account_mode_not_for_environment', 'test_adapter_blocked_in_environment']);

/** The words for a connection test result; an unknown code reads as a generic failure. */
export const testResultText = (code: string | null): string =>
  code === null ? t('admin.gateways.test.never') : t(`admin.gateways.test.${KNOWN_RESULTS.has(code) ? code : 'provider_rejected'}`);

export const statusText = (s: AccountStatus): string => t(`admin.gateways.status.${s}`);

/** The actions offered for an account: exactly the transitions the API lists, in a stable order. */
export function actionsFor(a: Pick<AccountView, 'allowedTransitions'>): Array<{ to: AccountStatus; label: string }> {
  const order: AccountStatus[] = ['active', 'paused', 'retired', 'archived'];
  return order.filter((s) => a.allowedTransitions.includes(s)).map((to) => ({ to, label: t(`admin.gateways.action.${to}`) }));
}

/** Why an adapter cannot have an account here, in words. */
export const creatableText = (a: Pick<AdapterView, 'creatable' | 'creatableReason'>): string =>
  a.creatable ? t('admin.gateways.catalogue.creatable') : t(`admin.gateways.catalogue.reason.${a.creatableReason && KNOWN_REASONS.has(a.creatableReason) ? a.creatableReason : 'adapter_unavailable'}`);

const CARD_ENTRY_KEYS: Record<AdapterCapabilities['cardEntry'], string> = {
  gateway_page: 'cardEntryGatewayPage', card_fields: 'cardEntryCardFields', simulated: 'cardEntrySimulated', manual: 'cardEntryManual',
};
const REFUND_KEYS: Record<AdapterCapabilities['refunds'], string> = { partial: 'refundsPartial', full: 'refundsFull', none: 'refundsNone' };

/** Task 9.1 (plan docs/plans/9.1-eway.md, section 13): an adapter's capabilities in words, from closed lists only. */
export function capabilitiesText(c: AdapterCapabilities | null | undefined): string[] {
  const k = (key: string) => t(`admin.gateways.catalogue.capability.${key}`);
  if (!c) return [k('none')];
  const out = [k(CARD_ENTRY_KEYS[c.cardEntry] ?? 'cardEntryGatewayPage'), k(REFUND_KEYS[c.refunds] ?? 'refundsNone'), k(c.gatewayEvents === 'none' ? 'eventsNone' : 'eventsSigned')];
  if (c.disputes) out.push(k('disputes'));
  if (c.reconciliation && (c.reconciliation.activity || c.reconciliation.settlements)) out.push(k('reconciliation'));
  return out;
}

/** A warning in words, naming the account by its display name (never by anything secret). */
export function warningText(w: Warning, accounts: ReadonlyArray<Pick<AccountView, 'id' | 'displayName'>>): string {
  const code = KNOWN_WARNINGS.has(w.code) ? w.code : 'unknown';
  const account = accounts.find((a) => a.id === w.accountId)?.displayName ?? t('admin.gateways.unnamed');
  return t(`admin.gateways.warning.${code}`, { account, country: w.country ?? '', reason: w.reason ? t(`admin.gateways.pauseReason.${w.reason}`) : '' });
}

/** The method/country pairs a change would leave without a way to pay, for the confirmation. */
export const lostText = (lost: ReadonlyArray<{ method: string; country: string }>): string =>
  lost.map((l) => t('admin.gateways.lostPair', { method: t(`admin.gateways.method.${l.method}`), country: l.country })).join(', ');

/** The credentials a form sends: only the fields the adapter declares, only those filled in (each optional on a change). */
export function credentialsFrom(form: FormData, fields: ReadonlyArray<{ key: string }>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = String(form.get(`${prefix}${f.key}`) ?? '');
    if (v !== '') out[f.key] = v;
  }
  return out;
}
