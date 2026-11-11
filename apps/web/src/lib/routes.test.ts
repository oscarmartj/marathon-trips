import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminRoutes, publicRoutes } from './routes';
import { t } from './i18n';

const appDir = join(__dirname, '..', 'app');
const all = [...publicRoutes, ...adminRoutes];

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'api' ? [] : pageFiles(p);
    return name === 'page.tsx' ? [relative(appDir, p).split('\\').join('/')] : [];
  });
}

describe('route table', () => {
  it.each(all)('$path has a page file and a translated label', (r) => {
    expect(existsSync(join(appDir, r.file))).toBe(true);
    expect(t(r.labelKey).length).toBeGreaterThan(0);
  });

  it('lists every page file under src/app (no page missing from the table)', () => {
    expect(pageFiles(appDir).sort()).toEqual(all.map((r) => r.file).sort());
  });

  it('has unique paths', () => {
    expect(new Set(all.map((r) => r.path)).size).toBe(all.length);
  });

  it('keeps all admin pages under /admin and none of the public pages there', () => {
    expect(adminRoutes.every((r) => r.path.startsWith('/admin'))).toBe(true);
    expect(publicRoutes.some((r) => r.path.startsWith('/admin'))).toBe(false);
  });

  it('shows the legal pages in the footer and provisional legal notice is present', () => {
    expect(publicRoutes.filter((r) => r.footer === 'legal').map((r) => r.path)).toEqual(['/legal/terms', '/legal/privacy', '/legal/complaints']);
  });
});
