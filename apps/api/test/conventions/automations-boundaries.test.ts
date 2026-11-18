// Task 7.4 (plan section 1, point c): the automations module never imports code that moves money, changes a booking's
// state, or administers access, flags or settings. A text check like module-boundaries: no TypeScript internals needed.
// Task 7.fix-2: every file under the module, subfolders included, and static, dynamic import() and require() alike.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../../src/modules/automations');
/** Any module specifier (static import or export, import(), require()) naming a money module at any relative depth. */
const MONEY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"`](?:\.{1,2}\/)+(?:[\w.-]+\/)*?(?:modules\/)?(payments|pricing|finance|changes)(?:\/[^'"`]*)?['"`]/;
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [MONEY_IMPORT, 'a money module'],
  [/\bBookingStateMachine\b|\bBookingTransitionHooks\b|state-machine/, 'booking transitions'],
  [/platform\/access\/(roles-admin|staff-admin)\.service|admin\.controller/, 'access administration'],
  [/flags-admin\.service|\bSettingsService\b/, 'flag or setting administration'],
  [/integrations\/(api-keys|api-key-auth)\.service/, 'API keys'],
  [/\bupdateMany\b[^;]*\bbookings?\b|UPDATE\s+"?bookings"?/i, 'booking writes'],
];

function tsFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    const path = join(root, e.name);
    if (e.isDirectory()) return tsFiles(path);
    return e.isFile() && e.name.endsWith('.ts') ? [path] : [];
  });
}

describe('automations_code_never_imports_money_or_access', () => {
  const files = tsFiles(dir).map((f) => relative(dir, f));
  it('has source files to check', () => expect(files.length).toBeGreaterThan(5));
  it.each(files)('%s', (f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const [re, what] of FORBIDDEN) expect(re.test(text), `${f} touches ${what}`).toBe(false);
  });

  it('the money pattern catches static, dynamic and nested imports', () => {
    const caught = [
      `import { x } from '../payments';`,
      `import { x } from "../payments/core/ledger";`,
      `export * from '../pricing';`,
      `const m = await import('../payments');`,
      `const m = await import( "../../modules/finance/index" );`,
      'const m = await import(`../changes`);',
      `const m = require('../payments/core');`,
      `import '../payments/side-effect';`,
      `import { x } from '../../payments';`,
    ];
    for (const line of caught) expect(MONEY_IMPORT.test(line), line).toBe(true);
    const allowed = [`import { x } from '../catalogue';`, `import { x } from '../../platform/mail/mail.service';`, `// payments are parked`, `const key = 'payments.refund';`];
    for (const line of allowed) expect(MONEY_IMPORT.test(line), line).toBe(false);
  });

  it('walks subfolders', () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-boundaries-'));
    try {
      mkdirSync(join(root, 'nested/deeper'), { recursive: true });
      writeFileSync(join(root, 'a.ts'), '');
      writeFileSync(join(root, 'nested/deeper/b.ts'), '');
      writeFileSync(join(root, 'nested/c.md'), '');
      expect(tsFiles(root).map((f) => relative(root, f)).sort()).toEqual(['a.ts', join('nested', 'deeper', 'b.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
