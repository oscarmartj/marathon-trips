// Pure helpers for the catalogue panel (task 1.2). Nothing here computes a price: money is moved between the text a person
// types and the string of integer minor units the API uses, with string operations only (no floats near money).

export type Localised = Record<string, string>;
export const MAIN_LOCALE = 'en-AU';

/** The en-AU text of a localised value, or an empty string. */
export function enAU(value: unknown): string {
  if (value && typeof value === 'object') {
    const v = (value as Record<string, unknown>)[MAIN_LOCALE];
    if (typeof v === 'string') return v;
  }
  return '';
}

/** A localised value with the en-AU text replaced and every other language kept as it was. */
export function withEnAU(previous: unknown, text: string): Localised {
  const rest = previous && typeof previous === 'object' ? Object.fromEntries(Object.entries(previous as Record<string, unknown>).filter(([k, v]) => k !== MAIN_LOCALE && typeof v === 'string')) : {};
  return { ...(rest as Localised), [MAIN_LOCALE]: text.trim() };
}

/** Like withEnAU, but an empty text removes en-AU (for optional fields such as "includes"). */
export function withOptionalEnAU(previous: unknown, text: string): Localised {
  const next = withEnAU(previous, text);
  if (next[MAIN_LOCALE] === '') delete next[MAIN_LOCALE];
  return next;
}

/** '500', '500.5' or '500.50' to '50000', '50050', '50050'. Null when it is not an amount with at most two decimals. */
export function dollarsToMinor(input: string): string | null {
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const minor = `${m[1]}${(m[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  return minor;
}

/** '50000' to '500.00'. */
export function minorToDollars(minor: string): string {
  const digits = minor.replace(/^0+(?=\d)/, '').padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** '25' or '25.5' to 2500 or 2550 (basis points). Null when it is not between 0.01 and 100 with at most two decimals. */
export function percentToBps(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bps >= 1 && bps <= 10000 ? bps : null;
}

/** 2500 to '25'; 2550 to '25.5'. */
export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0$/, '');
  return frac === '' || frac === '0' ? String(whole) : `${whole}.${frac}`;
}

/** Whole nights between two YYYY-MM-DD dates (calendar days, no time zones). */
export function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A whole number from a form field, or undefined when the field is empty or not a whole number. */
export function wholeNumber(text: string): number | undefined {
  return /^-?\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

export const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
