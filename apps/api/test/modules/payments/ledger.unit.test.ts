// The ledger's pure parts and the refund state table (plan docs/plans/3.3-stripe-adapter-ledger.md, sections 1.4, 3 and
// 12.7). No database.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allocate } from '../../../src/modules/payments/core/allocation';
import { LEDGER_ACCOUNTS, assertBalanced, contentSha256, customerSide } from '../../../src/modules/payments/core/ledger';
import type { LedgerLine } from '../../../src/modules/payments/core/ledger';
import { REFUND_STATUS_PAIRS, nextRefundStatus } from '../../../src/modules/payments/core/refunds.service';
import type { RefundEvent, RefundStatusName } from '../../../src/modules/payments/core/refunds.service';

const F = LEDGER_ACCOUNTS.funds;
const O = LEDGER_ACCOUNTS.overpayments;
const lines = (ls: LedgerLine[]) => Object.fromEntries(ls.map((l) => [l.accountCode, l.amountMinor]));
const items = (...amounts: bigint[]) => amounts.map((amountMinor, i) => ({ sequence: i + 1, amountMinor }));
const target = (its: ReturnType<typeof items>, net: bigint) => {
  const a = allocate(its, net);
  return { fundsMinor: a.items.reduce((s, i) => s + i.paidMinor, 0n), overpaymentsMinor: a.overpaidMinor };
};

describe('customer_side_table (plan 3.3, 1.4 and 12.7)', () => {
  const plan = items(30_000n, 70_000n);
  it.each([
    ['deposit paid', target(plan, 30_000n), { fundsMinor: 0n, overpaymentsMinor: 0n }, 30_000n, { [F]: -30_000n }],
    ['full payment', target(plan, 100_000n), { fundsMinor: 0n, overpaymentsMinor: 0n }, 100_000n, { [F]: -100_000n }],
    ['overpaid by a late success', target(plan, 130_000n), { fundsMinor: 100_000n, overpaymentsMinor: 0n }, 30_000n, { [O]: -30_000n }],
    ['refund of the overpaid part', target(plan, 100_000n), { fundsMinor: 100_000n, overpaymentsMinor: 30_000n }, -30_000n, { [O]: 30_000n }],
    ['refund across items', target(plan, 20_000n), { fundsMinor: 100_000n, overpaymentsMinor: 0n }, -80_000n, { [F]: 80_000n }],
    ['refund after the plan went down (opposite signs)', target(items(50_000n), 60_000n), { fundsMinor: 80_000n, overpaymentsMinor: 0n }, -20_000n, { [F]: 30_000n, [O]: -10_000n }],
    ['plan up: overpayment becomes funds', target(items(30_000n, 100_000n), 120_000n), { fundsMinor: 100_000n, overpaymentsMinor: 20_000n }, 0n, { [F]: -20_000n, [O]: 20_000n }],
    ['plan down: funds become overpayment', target(items(30_000n, 40_000n), 100_000n), { fundsMinor: 100_000n, overpaymentsMinor: 0n }, 0n, { [F]: 30_000n, [O]: -30_000n }],
    ['superseded plan (owes 0)', target([], 30_000n), { fundsMinor: 30_000n, overpaymentsMinor: 0n }, 0n, { [F]: 30_000n, [O]: -30_000n }],
    ['nothing changes', target(plan, 30_000n), { fundsMinor: 30_000n, overpaymentsMinor: 0n }, 0n, {}],
    ['drift is corrected by the next posting', target(plan, 50_000n), { fundsMinor: 10_000n, overpaymentsMinor: 20_000n }, 20_000n, { [F]: -40_000n, [O]: 20_000n }],
  ] as const)('%s', (_l, t, b, cash, expected) => {
    const out = customerSide(t, b, cash);
    expect(lines(out)).toEqual(expected);
    // With the cash line, every posting balances.
    expect(out.reduce((s, l) => s + l.amountMinor, 0n) + cash).toBe(0n);
  });
});

describe('ledger_split_property (2 000 seeded sequences)', () => {
  // Deterministic generator (mulberry32) so a failure is reproducible.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  it('the postings always sum to the final allocation, balance and have no zero line', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const amt = () => BigInt(1 + Math.floor(r() * 200)) * 500n;
      let plan = items(amt(), amt());
      let net = 0n;
      const ledger = { fundsMinor: 0n, overpaymentsMinor: 0n };
      for (let step = 0; step < 12; step++) {
        const roll = r();
        let cash = 0n;
        if (roll < 0.4) cash = amt();
        else if (roll < 0.6 && net > 0n) cash = -(BigInt(Math.floor(r() * Number(net))) + 1n);
        else if (roll < 0.8) plan = r() < 0.2 ? [] : items(...Array.from({ length: 1 + Math.floor(r() * 3) }, amt));
        net += cash;
        const out = customerSide(target(plan, net), ledger, cash);
        if (cash !== 0n) assertBalanced([{ accountCode: 'provider_clearing:x', amountMinor: cash }, ...out]);
        else if (out.length > 0) assertBalanced(out);
        for (const l of out) {
          if (l.accountCode === F) ledger.fundsMinor -= l.amountMinor;
          else ledger.overpaymentsMinor -= l.amountMinor;
        }
        expect(ledger, `seed ${seed} step ${step}`).toEqual(target(plan, net));
      }
    }
  });
});

describe('ledger content fingerprint', () => {
  const base = { kind: 'payment', mode: 'test', currency: 'AUD', bookingId: 'b', paymentId: 'p', refundId: null, reversesTransactionId: null, description: 'payment_succeeded' };
  it('does not depend on line order, does depend on amounts', () => {
    const a = contentSha256({ ...base, lines: [{ accountCode: 'x', amountMinor: 1n }, { accountCode: 'y', amountMinor: -1n }] });
    const b = contentSha256({ ...base, lines: [{ accountCode: 'y', amountMinor: -1n }, { accountCode: 'x', amountMinor: 1n }] });
    const c = contentSha256({ ...base, lines: [{ accountCode: 'x', amountMinor: 2n }, { accountCode: 'y', amountMinor: -2n }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it('unbalanced, single-line or zero-line postings are refused', () => {
    expect(() => assertBalanced([{ accountCode: 'x', amountMinor: 1n }])).toThrow();
    expect(() => assertBalanced([{ accountCode: 'x', amountMinor: 1n }, { accountCode: 'y', amountMinor: -2n }])).toThrow();
    expect(() => assertBalanced([{ accountCode: 'x', amountMinor: 0n }, { accountCode: 'y', amountMinor: 0n }])).toThrow();
  });
});

describe('refund_state_table (plan 0.1, 6.2)', () => {
  const states: RefundStatusName[] = ['requested', 'pending', 'succeeded', 'failed', 'reversed'];
  const events: RefundEvent[] = ['pending', 'succeeded', 'failed', 'reversal_confirmed'];
  it('every move the table makes is a pair the trigger allows, and nothing goes back', () => {
    const allowed = new Set(REFUND_STATUS_PAIRS.map(([a, b]) => `${a}>${b}`));
    for (const s of states) for (const e of events) {
      const to = nextRefundStatus(s, e);
      if (to) expect(allowed.has(`${s}>${to}`), `${s} --${e}--> ${to}`).toBe(true);
    }
    expect(nextRefundStatus('succeeded', 'failed')).toBeNull();
    expect(nextRefundStatus('succeeded', 'reversal_confirmed')).toBe('reversed');
    expect(nextRefundStatus('failed', 'succeeded')).toBeNull();
    expect(nextRefundStatus('reversed', 'succeeded')).toBeNull();
    expect(nextRefundStatus('pending', 'pending')).toBeNull();
  });
});

const SRC = join(__dirname, '../../../src');
const sources = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? (n === 'generated' ? [] : sources(p)) : p.endsWith('.ts') ? [p] : [];
});

describe('writers of money tables (plan 3.3, 1.2 and 3.1)', () => {
  it('refund_status_pairs_code_matches_trigger', () => {
    const sql = readFileSync(join(__dirname, '../../../prisma/migrations/0033_ledger_refunds/migration.sql'), 'utf8');
    const block = sql.slice(sql.indexOf('IF NOT ((OLD."status", NEW."status") IN ('), sql.indexOf('refund status cannot go from'));
    const pairs = [...block.matchAll(/\('(\w+)'(?:::"RefundStatus")?, '(\w+)'(?:::"RefundStatus")?\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    expect(pairs).toEqual(REFUND_STATUS_PAIRS.map((p) => p.join('>')).sort());
  });

  it('only_ledger_service_writes_ledger, and only the refund state machine writes a refund status', () => {
    const ledgerWriters: string[] = [];
    const refundStatusWriters: string[] = [];
    for (const f of sources(SRC)) {
      const text = readFileSync(f, 'utf8');
      const name = relative(SRC, f);
      if (/INSERT INTO ledger_|UPDATE ledger_|DELETE FROM ledger_|ledger(Transaction|Entry|Account)\.(create|update|upsert|delete)/.test(text)) ledgerWriters.push(name);
      if (/UPDATE refunds SET status|refund\.(update|updateMany|upsert)\([^)]*status/.test(text)) refundStatusWriters.push(name);
    }
    expect(ledgerWriters).toEqual(['modules/payments/core/ledger.service.ts']);
    expect(refundStatusWriters).toEqual(['modules/payments/core/refunds.service.ts']);
    // No route writes the ledger: no controller mentions it.
    const controllers = sources(SRC).filter((f) => /controller/.test(f)).filter((f) => /ledger/i.test(readFileSync(f, 'utf8')));
    expect(controllers.map((f) => relative(SRC, f))).toEqual([]);
  });
});
