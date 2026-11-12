import { describe, expect, it } from 'vitest';
import { createQuoteLoader, isBreakdown, type QuoteOutcome } from './quote-loader';
import { defaultState } from './builder';
import { breakdown } from '@/test/breakdown-fixture';
import { packageDetail } from '@/test/catalogue-fixtures';

const pkg = packageDetail();
const state = defaultState(pkg);

function deferred() {
  let resolve!: (v: { status: number; body: unknown }) => void;
  const promise = new Promise<{ status: number; body: unknown }>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('quote loader', () => {
  it('delivers the answer for the newest ask even if an older one finishes last', async () => {
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    const delivered: QuoteOutcome[] = [];
    const load = createQuoteLoader(() => queue.shift()!.promise, (o) => delivered.push(o));
    const a = load(pkg, state);
    const b = load(pkg, state);
    second.resolve({ status: 200, body: breakdown({ totalMinor: '222' }) });
    await b;
    first.resolve({ status: 200, body: breakdown({ totalMinor: '111' }) });
    await a;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ ok: true, breakdown: { totalMinor: '222' } });
  });

  it('turns a failed status and a network failure into errors, not a total', async () => {
    const out: QuoteOutcome[] = [];
    await createQuoteLoader(async () => ({ status: 422, body: {} }), (o) => out.push(o))(pkg, state);
    await createQuoteLoader(async () => { throw new Error('offline'); }, (o) => out.push(o))(pkg, state);
    expect(out).toEqual([{ ok: false, status: 422 }, { ok: false, status: 0 }]);
  });

  it('treats a 200 with a malformed body as an error', async () => {
    const out: QuoteOutcome[] = [];
    await createQuoteLoader(async () => ({ status: 200, body: { totalMinor: 'abc' } }), (o) => out.push(o))(pkg, state);
    expect(out).toEqual([{ ok: false, status: 500 }]);
    expect(isBreakdown(breakdown())).toBe(true);
    expect(isBreakdown({ ...breakdown(), totalMinor: '12.5' })).toBe(false);
  });

  it('sends a request with only choices in it', async () => {
    let sent: unknown;
    await createQuoteLoader(async (r) => { sent = r; return { status: 200, body: breakdown() }; }, () => undefined)(pkg, state);
    expect(Object.keys(sent as object).sort()).toEqual(['extraNightsAfter', 'extraNightsBefore', 'extras', 'packageId', 'rooms']);
  });
});
