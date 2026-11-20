// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md, section 4): the cash forecast, pure. Expected customer money and
// supplier payments by Brisbane date, per currency. Nothing is converted and no currency is added to another. The net is
// the cautious one: instalments of confirmed bookings less supplier payments; money still tentative or from penalties is
// shown beside it, not in it. Debt, money to give back and refunds in flight are kept apart by the service.

/** A calendar date plus a number of days (negative goes back). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type InKind = 'instalments' | 'tentative' | 'penalties';
export interface ForecastIn { packageId: string | null; currency: string; date: string; kind: InKind; amountMinor: bigint }
export interface ForecastOut { packageId: string | null; currency: string; date: string | null; amountMinor: bigint }

export interface Amounts { instalmentsInMinor: bigint; tentativeInMinor: bigint; penaltiesInMinor: bigint; supplierOutMinor: bigint; firmNetMinor: bigint }
export interface ForecastDay extends Amounts { date: string; runningNetMinor: bigint }
export interface CurrencyForecast {
  currency: string;
  days: ForecastDay[];
  /** Due before today in Brisbane: late, so less certain; never in the running net. */
  overdue: Amounts;
  /** Dated from today but before the window starts. */
  earlier: Amounts;
  /** After the window. */
  later: Amounts;
  /** Supplier costs with no due date. */
  undated: Amounts;
  /** Every bucket added: the total of what is expected and what is owed. */
  all: Amounts;
}
export interface TripForecast extends Amounts { packageId: string | null; currency: string }

const zero = (): Amounts => ({ instalmentsInMinor: 0n, tentativeInMinor: 0n, penaltiesInMinor: 0n, supplierOutMinor: 0n, firmNetMinor: 0n });

function addIn(a: Amounts, i: { kind: InKind; amountMinor: bigint }): void {
  if (i.kind === 'instalments') a.instalmentsInMinor += i.amountMinor;
  else if (i.kind === 'tentative') a.tentativeInMinor += i.amountMinor;
  else a.penaltiesInMinor += i.amountMinor;
  a.firmNetMinor = a.instalmentsInMinor - a.supplierOutMinor;
}
function addOut(a: Amounts, amountMinor: bigint): void {
  a.supplierOutMinor += amountMinor;
  a.firmNetMinor = a.instalmentsInMinor - a.supplierOutMinor;
}

/** Which bucket a date falls in. `null` is undated (money out only). */
export function forecastBucket(date: string | null, today: string, from: string, to: string): 'overdue' | 'earlier' | 'window' | 'later' | 'undated' {
  if (date === null) return 'undated';
  if (date < today) return 'overdue';
  if (date < from) return 'earlier';
  if (date > to) return 'later';
  return 'window';
}

export function buildForecast(input: { ins: readonly ForecastIn[]; outs: readonly ForecastOut[]; today: string; from: string; to: string }): { currencies: CurrencyForecast[]; trips: TripForecast[] } {
  const by = new Map<string, { days: Map<string, Amounts>; overdue: Amounts; earlier: Amounts; later: Amounts; undated: Amounts; all: Amounts }>();
  const trips = new Map<string, TripForecast>();
  const slot = (currency: string) => {
    let s = by.get(currency);
    if (!s) by.set(currency, (s = { days: new Map(), overdue: zero(), earlier: zero(), later: zero(), undated: zero(), all: zero() }));
    return s;
  };
  const trip = (packageId: string | null, currency: string) => {
    const k = `${packageId ?? ''}|${currency}`;
    let t = trips.get(k);
    if (!t) trips.set(k, (t = { packageId, currency, ...zero() }));
    return t;
  };
  for (const i of input.ins) {
    if (i.amountMinor <= 0n) continue;
    const s = slot(i.currency);
    const b = forecastBucket(i.date, input.today, input.from, input.to);
    const target = b === 'window' ? (s.days.get(i.date) ?? s.days.set(i.date, zero()).get(i.date)!) : s[b as 'overdue' | 'earlier' | 'later'];
    addIn(target, i); addIn(s.all, i); addIn(trip(i.packageId, i.currency), i);
  }
  for (const o of input.outs) {
    if (o.amountMinor <= 0n) continue;
    const s = slot(o.currency);
    const b = forecastBucket(o.date, input.today, input.from, input.to);
    const target = b === 'window' ? (s.days.get(o.date!) ?? s.days.set(o.date!, zero()).get(o.date!)!) : s[b];
    addOut(target, o.amountMinor); addOut(s.all, o.amountMinor); addOut(trip(o.packageId, o.currency), o.amountMinor);
  }
  const currencies = [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, s]) => {
    let running = 0n;
    const days = [...s.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, a]) => {
      running += a.firmNetMinor;
      return { date, ...a, runningNetMinor: running };
    });
    return { currency, days, overdue: s.overdue, earlier: s.earlier, later: s.later, undated: s.undated, all: s.all };
  });
  return { currencies, trips: [...trips.values()].sort((a, b) => a.currency.localeCompare(b.currency) || String(a.packageId).localeCompare(String(b.packageId))) };
}
