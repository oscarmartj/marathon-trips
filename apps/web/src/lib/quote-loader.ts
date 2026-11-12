import type { PriceBreakdownJson } from '@mt/shared';
import type { PackageDetail } from './catalogue';
import { toQuoteRequest, type BuilderState } from './builder';

export type QuoteOutcome = { ok: true; breakdown: PriceBreakdownJson } | { ok: false; status: number };
export type QuoteSender = (request: ReturnType<typeof toQuoteRequest>) => Promise<{ status: number; body: unknown }>;

/**
 * Asks the API for a price. Several asks can be in flight while someone clicks; only the newest answer is delivered,
 * so a total on screen never belongs to an older configuration than the choices next to it.
 */
export function createQuoteLoader(send: QuoteSender, deliver: (outcome: QuoteOutcome) => void) {
  let latest = 0;
  return async function load(pkg: PackageDetail, state: BuilderState): Promise<void> {
    const mine = ++latest;
    let outcome: QuoteOutcome;
    try {
      const res = await send(toQuoteRequest(pkg, state));
      outcome = res.status === 200 && isBreakdown(res.body) ? { ok: true, breakdown: res.body } : { ok: false, status: res.status === 200 ? 500 : res.status };
    } catch {
      outcome = { ok: false, status: 0 };
    }
    if (mine === latest) deliver(outcome);
  };
}

/** The few fields the page reads, checked, so a malformed answer is an error and never a half-drawn total. */
export function isBreakdown(b: unknown): b is PriceBreakdownJson {
  const x = b as Partial<PriceBreakdownJson> | null;
  const digits = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
  return !!x && typeof x === 'object' && typeof x.currency === 'string' && digits(x.totalMinor) && Array.isArray(x.lines) && !!x.subtotals && digits(x.subtotals.subtotal)
    && Array.isArray(x.perTraveller) && (x.depositMinor === null || digits(x.depositMinor)) && (x.balanceMinor === null || digits(x.balanceMinor));
}
