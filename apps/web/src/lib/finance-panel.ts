// Pure helpers of the trip results, cash forecast and accountant export panels (task 6.6). Amounts are digit strings from
// the API: they are formatted, never added up here.
import { t } from './i18n-admin';

export const EXPORT_DATASETS = ['trip_result', 'ledger', 'supplier_payments'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];
export const EXPORT_ERROR_CODES = ['range_invalid', 'range_too_long', 'export_too_large', 'validation_failed', 'rate_limited'] as const;

/** The request of a download; the server checks every field again. */
export function exportBody(dataset: string, from: string, to: string): { dataset: ExportDataset; from: string; to: string } | null {
  if (!(EXPORT_DATASETS as readonly string[]).includes(dataset) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return { dataset: dataset as ExportDataset, from, to };
}

/** The message for a failed download: the catalogue's wording for the code, else the general one. */
export function exportErrorMessage(r: { status: number; body: { code?: string } }): string {
  const code = r.status === 429 ? 'rate_limited' : r.body?.code;
  if (code && (EXPORT_ERROR_CODES as readonly string[]).includes(code)) return t(`admin.tripResults.export.errors.${code}`);
  if (r.status === 422) return t('admin.tripResults.export.errors.validation_failed');
  if (r.status === 403) return t('admin.common.forbidden');
  return t('admin.common.error');
}

/** A forecast query from the filter's dates; empty dates are left out. */
export function forecastQuery(from: string, to: string): string {
  const q = new URLSearchParams();
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) q.set('from', from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) q.set('to', to);
  return q.size ? `?${q.toString()}` : '';
}

/** A rate the API sent as a whole number of billionths, as a decimal text ("10000000" is "0.01"). Digits only: nothing is divided. */
export function rateText(e9: string): string {
  if (!/^\d+$/.test(e9)) return '';
  const s = e9.padStart(10, '0');
  const frac = s.slice(-9).replace(/0+$/, '');
  return `${s.slice(0, -9)}${frac ? `.${frac}` : ''}`;
}

export const checkName = (name: string): string => {
  try {
    return t(`admin.tripResults.results.checkNames.${name}`);
  } catch {
    return name;
  }
};

export const FORECAST_BUCKETS = ['overdue', 'earlier', 'later', 'undated', 'all'] as const;
export const bucketTitle = (b: string): string => t(`admin.tripResults.forecast.buckets.${b}`);
