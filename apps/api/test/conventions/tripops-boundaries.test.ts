// Task 7.1: the trip lists module only reads, never reads money or contact data, never selects the personal columns a
// list does not need, and never logs. The columns are named here so adding one to a list means changing this test.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../../src/modules/tripops');
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/from '\.\.\/(payments|pricing|finance|changes|crm)(\/|')/, 'a money or customer-contact module'],
  [/from '\.\.\/[a-z-]+\/(?!index)/, 'module internals'],
  [/\bBookingStateMachine\b|state-machine|\bAllotmentService\b/, 'booking transitions or allotments'],
  [/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\$execute|UPDATE\s+"?\w|INSERT\s+INTO|DELETE\s+FROM/i, 'a write'],
  [/dateOfBirth|emergencyContact|estimatedFinish|totalMinor|depositMinor|priceBreakdown|payment|requestContactHmac|\bphone\b|\bemail\b/i, 'a column or word outside the whitelist'],
  [/\bLogger\b|console\.|this\.logger/, 'logging'],
];

describe('tripops_code_only_reads_and_stays_inside_its_whitelist', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('has source files to check', () => expect(files.length).toBeGreaterThanOrEqual(5));
  it.each(files)('%s', (f) => {
    const text = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const [re, what] of FORBIDDEN) {
      // The audit write is the one allowed: it goes through AuditService, not a Prisma writer.
      expect(re.test(text), `${f} uses ${what}`).toBe(false);
    }
  });
});
