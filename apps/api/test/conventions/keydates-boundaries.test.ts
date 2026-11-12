// Task 7.3: the key dates module only reads bookings, allotments and the catalogue (through their public read functions)
// and writes its own table and tasks. It never imports code that moves money or changes a booking or an allotment.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../../src/modules/keydates');
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/from '\.\.\/(payments|pricing|finance|changes)(\/|')/, 'a money module'],
  [/\bBookingStateMachine\b|\bBookingTransitionHooks\b|state-machine/, 'booking transitions'],
  [/\bAllotmentService\b|\bSupplierService\b|\bCostService\b/, 'supplier writes'],
  [/from '\.\.\/(bookings|suppliers|catalogue)\/(?!index)/, 'module internals'],
  [/\b(booking|allotment|costItem|payment)\.(create|update|updateMany|delete|deleteMany|upsert)\b|UPDATE\s+"?(bookings|allotments)"?/i, 'writes to another module'],
];

describe('keydates_code_reads_other_modules_and_never_writes_them', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('has source files to check', () => expect(files.length).toBeGreaterThan(4));
  it.each(files)('%s', (f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const [re, what] of FORBIDDEN) expect(re.test(text), `${f} touches ${what}`).toBe(false);
  });
});
