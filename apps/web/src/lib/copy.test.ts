import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messageCatalogue } from './i18n';

const srcDir = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : [];
  });
}

function leaves(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  return Object.entries(node as object).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
}

describe('copy', () => {
  it('has no hard-coded user-facing text in components or pages', () => {
    const offenders: string[] = [];
    for (const f of files(srcDir)) {
      const src = readFileSync(f, 'utf8');
      // Text between tags, or literal accessibility/label attributes, that contain letters.
      for (const m of src.matchAll(/>\s*([A-Za-z][^<>{}]*)</g)) offenders.push(`${f}: text "${m[1]!.trim()}"`);
      for (const m of src.matchAll(/\b(alt|aria-label|title|placeholder)="([^"]*[A-Za-z][^"]*)"/g)) offenders.push(`${f}: ${m[1]}="${m[2]}"`);
    }
    expect(offenders).toEqual([]);
  });

  it('uses Australian spelling in the catalogue', () => {
    const us = /\b(color|colors|center|centers|favorite|organize|organization|license|program|traveler|traveling|cancelled|catalog)\b/i;
    const bad = leaves(messageCatalogue()).filter(([, v]) => us.test(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('has no brand name typed into the catalogue (it comes from the brand config)', () => {
    const bad = leaves(messageCatalogue()).filter(([, v]) => /marathon trips/i.test(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
