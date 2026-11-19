// Pure helpers of the supplier payment pages (task 6.2). Amounts are digit strings from the API: they are formatted,
// never added up here. The only amount typed in is what the bank debited in another currency, parsed to minor units.
import { toMinor } from './supplier-format';
import { t } from './i18n';

export const PAYMENT_ERROR_CODES = [
  'cost_item_already_paid', 'cost_item_not_payable', 'cost_items_currency_mismatch', 'paid_on_in_future', 'paid_on_too_old', 'base_currency_same_as_payment',
  'supplier_payment_already_voided', 'instalment_dates_not_increasing',
] as const;

/**
 * The message for an API error code of these pages: their own wording, then the panel's shared wording for the code
 * (version_conflict, validation_failed…), then the general one. Kept short: the panel's copy ships with every page.
 */
export function paymentErrorMessage(code: string | undefined): string {
  if (code && (PAYMENT_ERROR_CODES as readonly string[]).includes(code)) return t(`admin.suppliers.payments.errors.${code}`);
  if (code === 'bad_amount') return t('admin.suppliers.errors.bad_amount');
  if (code) {
    try {
      return t(`admin.catalogue.errors.${code}`);
    } catch {
      /* the general message */
    }
  }
  return t('admin.common.error');
}

/** A fresh Idempotency-Key for one submission of a form (the same key is reused only when that submission is retried). */
export const newIdempotencyKey = (): string => `sp-${crypto.randomUUID()}`;

export const SCHEDULE_BUCKETS = ['overdue', 'due_today', 'upcoming', 'later', 'undated'] as const;

export function bucketLabel(bucket: string, leadDays: number): string {
  return (SCHEDULE_BUCKETS as readonly string[]).includes(bucket) ? t(`admin.supplierSchedule.buckets.${bucket}`, { days: leadDays }) : bucket;
}

export interface SelectedCost { id: string; version: number }

export type RecordBody = { items: Array<{ costItemId: string; version: number }>; paidOn: string; reference: string; base: { amountMinor: string; currency: string } | null };

/**
 * The body of "record a payment". There is no amount field: the API sums the cost items. The bank amount is optional,
 * only for a bank account in another currency, and is sent as typed (parsed to minor units of its own currency).
 */
export function recordBody(selected: readonly SelectedCost[], paidOn: string, reference: string, baseAmount: string, baseCurrency: string): RecordBody | { error: string } {
  if (selected.length === 0) return { error: t('admin.suppliers.payments.chooseFirst') };
  let base: RecordBody['base'] = null;
  if (baseAmount.trim()) {
    const currency = baseCurrency.trim().toUpperCase();
    const amountMinor = /^[A-Z]{3}$/.test(currency) ? toMinor(baseAmount, currency) : null;
    if (amountMinor === null || !/[1-9]/.test(amountMinor)) return { error: t('admin.suppliers.errors.bad_amount') };
    base = { amountMinor, currency };
  }
  return { items: selected.map((c) => ({ costItemId: c.id, version: c.version })), paidOn, reference: reference.trim(), base };
}
