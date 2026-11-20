// Task 6.6: the staff panel's copy stays out of the public JavaScript (budget in e2e/public-site-quality.spec.ts).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import enAdmin from '../../messages/en-AU.admin.json';
import enPublic from '../../messages/en-AU.json';

const SRC = join(__dirname, '..');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});
const isTest = (f: string) => /\.test\.|\/test\//.test(f);
const rel = (f: string) => relative(SRC, f);
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('admin catalogue stays out of the public bundle (task 6.6)', () => {
  it('admin_copy_in_its_own_file: the public catalogue has no admin namespace and the admin file only that', () => {
    expect(Object.keys(enPublic)).not.toContain('admin');
    expect(Object.keys(enAdmin)).toEqual(['admin']);
  });

  it('i18n.ts does not import the admin file', () => {
    const src = code(join(SRC, 'lib/i18n.ts'));
    expect(src).not.toMatch(/en-AU\.admin|i18n-admin/);
  });

  it('only panel modules import i18n-admin; no public module uses an admin key', () => {
    for (const f of files(SRC).filter((x) => !isTest(x))) {
      const src = code(f);
      const r = rel(f);
      const panel = /^(components\/admin\/|app\/admin\/|components\/admin-page\.tsx|lib\/i18n-admin\.ts)/.test(r) || /-panel|panels?\.ts|supplier-payments\.ts/.test(r);
      if (/i18n-admin/.test(src) && !panel) throw new Error(`${r} imports i18n-admin but is not a panel module`);
      if (/from '(@\/lib\/i18n|\.\/i18n)'/.test(src) && /['"`]admin\./.test(src) && !/routes\.ts$/.test(r)) throw new Error(`${r} uses an admin key through the public i18n module`);
    }
  });

  it('nothing the public pages import, directly or through other modules, reaches the admin catalogue', () => {
    // The global test setup registers the admin copy, so a unit test cannot see a public page that needs it; the import graph can.
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? join(from, '..', spec) : null;
      if (!base) return null;
      return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find((c) => { try { return statSync(c).isFile(); } catch { return false; } }) ?? null;
    };
    const roots = files(SRC).filter((f) => !isTest(f) && /^app\/(?!admin\/)/.test(rel(f)));
    expect(roots.length).toBeGreaterThan(0);
    const seen = new Map<string, string>();
    const stack = roots.map((f) => [f, rel(f)] as const);
    while (stack.length) {
      const [f, via] = stack.pop()!;
      if (seen.has(f)) continue;
      seen.set(f, via);
      const src = code(f);
      if (/en-AU\.admin/.test(src) || (f.endsWith('lib/i18n-admin.ts') && !roots.includes(f))) throw new Error(`${via} reaches the admin catalogue through ${rel(f)}`);
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const next = resolve(f, m[1]!);
        if (next && !seen.has(next)) stack.push([next, `${via} > ${rel(next)}`]);
      }
    }
  });
});
