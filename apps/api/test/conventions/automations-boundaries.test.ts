// Task 7.4 (plan section 1, point c): the automations module never imports code that moves money, changes a booking's
// state, or administers access, flags or settings. A text check like module-boundaries: no TypeScript internals needed.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../../src/modules/automations');
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/from '\.\.\/(payments|pricing|finance|changes)(\/|')/, 'a money module'],
  [/\bBookingStateMachine\b|\bBookingTransitionHooks\b|state-machine/, 'booking transitions'],
  [/platform\/access\/(roles-admin|staff-admin)\.service|admin\.controller/, 'access administration'],
  [/flags-admin\.service|\bSettingsService\b/, 'flag or setting administration'],
  [/integrations\/(api-keys|api-key-auth)\.service/, 'API keys'],
  [/\bupdateMany\b[^;]*\bbookings?\b|UPDATE\s+"?bookings"?/i, 'booking writes'],
];

describe('automations_code_never_imports_money_or_access', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('has source files to check', () => expect(files.length).toBeGreaterThan(5));
  it.each(files)('%s', (f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const [re, what] of FORBIDDEN) expect(re.test(text), `${f} touches ${what}`).toBe(false);
  });
});
