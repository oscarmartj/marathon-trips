// Pure helpers of the reconciliation, customer money and receipts panels (task 4.6). Amounts are digit strings from the
// API: they are formatted, never added up here.
import { formatMoney } from './builder';
import { t } from './i18n';

export interface RunRow {
  id: string;
  providerAccountId: string;
  accountName: string;
  forDate: string;
  attempt: number;
  trigger: string;
  status: string;
  errorCode: string | null;
  checkedObjects: number;
  differenceCount: number;
}

export interface DifferenceSide { status?: string; amountMinor?: string; currency?: string }
export interface DifferenceRow { code: string; entityType: string; entityId: string; ours?: DifferenceSide; gateway?: DifferenceSide }

export const RUN_STATUSES = ['running', 'matched', 'mismatch', 'partial', 'failed', 'not_applicable'] as const;

export function runStatusLabel(status: string): string {
  return (RUN_STATUSES as readonly string[]).includes(status) ? t(`admin.reconciliation.statuses.${status}`) : status;
}

export function differenceLabel(code: string): string {
  try {
    return t(`admin.reconciliation.codes.${code}`);
  } catch {
    return code;
  }
}

/** One side of a difference in words: its status and amount, as the API sent them. */
export function sideText(s: DifferenceSide | undefined): string | null {
  if (!s) return null;
  const parts = [s.status ?? null, s.amountMinor !== undefined && s.currency ? formatMoney(s.amountMinor.replace(/^-/, ''), s.currency, s.amountMinor.startsWith('-') ? '-' : '') : (s.amountMinor ?? null)].filter((x): x is string => !!x);
  return parts.length ? parts.join(', ') : null;
}

/** One account per run list entry, newest first, for the "run now" buttons. */
export function accountsOf(runs: readonly RunRow[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const r of runs) if (!seen.has(r.providerAccountId)) seen.set(r.providerAccountId, r.accountName);
  return [...seen].map(([id, name]) => ({ id, name }));
}

/** A receipt download through the API proxy, or null for anything that is not a document number. */
export function adminReceiptHref(number: string): string | null {
  return /^MT-[TR]-[1-9][0-9]{0,17}$/.test(number) ? `/api/admin/payments/receipts/${number}` : null;
}

export const moneyOrDash = (minor: string | null | undefined, currency: string): string => (minor === null || minor === undefined ? t('admin.customerMoney.notAvailable') : formatMoney(minor, currency));

const ENTITIES = ['Payment', 'Refund', 'Dispute', 'Settlement', 'SettlementLine', 'GatewayObject'] as const;
export const entityLabel = (type: string): string => ((ENTITIES as readonly string[]).includes(type) ? t(`admin.reconciliation.entities.${type}`) : type);

const RECEIPT_KINDS = ['receipt', 'refund', 'refund_reversal', 'chargeback', 'chargeback_reinstatement', 'void'] as const;
/** The document's title in the panel's own words (not the API's), by its kind. */
export const receiptKindLabel = (kind: string): string => ((RECEIPT_KINDS as readonly string[]).includes(kind) ? t(`admin.crm.receipts.kinds.${kind}`) : kind);
