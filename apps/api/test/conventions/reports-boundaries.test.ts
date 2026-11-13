// Task 7.7: reports count things. The module never reads an amount of money, a payment or a person, and never writes
// another module's tables. Money is parked, so a column of an amount here would be a mistake.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOKING_COLUMNS, BOOKING_GROUPS, FUNNEL_COLUMNS, FUNNEL_GROUPS } from '@mt/shared';

const dir = join(__dirname, '../../src/modules/reports');
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/from '\.\.\/(payments|pricing|finance|changes)(\/|')/, 'a money module'],
  [/\bBookingStateMachine\b|state-machine/, 'booking transitions'],
  [/\b\w+Minor\b|\bpriceBreakdown\b|\bpayment_|"payments"/, 'an amount of money or a payment'],
  [/\b"?(customers|booking_travellers|travellers)"?\b|\bcustomerId\b|\bgivenName\b|\bfamilyName\b|\bphone\b/, 'a person'],
  [/from '\.\.\/(bookings|catalogue|suppliers|crm)\/(?!index)/, 'module internals'],
  [/\b(booking|race|raceEdition|package|customer)\.(create|update|updateMany|delete|deleteMany|upsert)\b|(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(bookings|races|race_editions|packages)"?/i, 'writes to another module'],
];

describe('reports_code_counts_and_never_reads_money_or_people', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('has source files to check', () => expect(files.length).toBeGreaterThan(6));
  it.each(files)('%s', (f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const [re, what] of FORBIDDEN) expect(re.test(text), `${f} touches ${what}`).toBe(false);
  });

  it('no grouping is a person', () => {
    for (const g of [...FUNNEL_GROUPS, ...BOOKING_GROUPS]) expect(g, g).not.toMatch(/customer|traveller|user|email|name|ref/);
  });

  it('no report column is an amount, a name or an address', () => {
    for (const c of [...FUNNEL_COLUMNS, ...BOOKING_COLUMNS]) expect(c, c).not.toMatch(/amount|total|price|money|minor|email|name|phone|ref/);
  });
});
