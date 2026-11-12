import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BANNER_TONES, CONTENT_KINDS, MENU_LOCATIONS, PAGE_KINDS, REDIRECT_CODES } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { ADMIN_KINDS, HAS_STATUS, contentInitial } from '@/lib/content-admin';
import { t } from '@/lib/i18n';
import { catalogueError } from '../catalogue/kit';
import { summaryOf } from './content-manager';

const PARAMS = { kind: 'x', name: 'x', path: 'x', slug: 'x', locale: 'x', status: 'x', race: 'x', question: 'x', message: 'x', place: 'x', label: 'x', href: 'x', from: 'x', to: 'x', code: 'x', state: 'x' };

describe('content manager copy', () => {
  it('every literal message key used by the content manager exists', () => {
    const keys = new Set<string>();
    const files = [
      ...readdirSync(__dirname).filter((f) => f.endsWith('.tsx')).map((f) => join(__dirname, f)),
      join(__dirname, '../../../app/admin/(panel)/content/page.tsx'),
      join(__dirname, '../../../app/admin/(panel)/content/[kind]/page.tsx'),
    ];
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'(admin\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThan(15);
    for (const k of keys) expect(() => t(k, PARAMS), k).not.toThrow();
  });

  it('has a name and a hint for every kind, and a label for every choice in the forms', () => {
    for (const k of ADMIN_KINDS) {
      expect(() => t(`admin.content.kinds.${k}`)).not.toThrow();
      expect(() => t(`admin.content.kindHints.${k}`)).not.toThrow();
    }
    for (const [group, values] of [['pageKinds', PAGE_KINDS], ['tones', BANNER_TONES], ['locations', MENU_LOCATIONS], ['codes', REDIRECT_CODES]] as const) {
      for (const v of values) expect(() => t(`admin.content.kindsLabels.${group}.${v}`), `${group}.${v}`).not.toThrow();
    }
    for (const s of ['draft', 'published']) expect(() => t(`admin.content.statuses.${s}`)).not.toThrow();
  });

  it('has a label for every form field the manager shows', () => {
    const src = readFileSync(join(__dirname, 'content-manager.tsx'), 'utf8');
    const keys = new Set([...src.matchAll(/\bf\('([A-Za-z]+)'/g)].map((m) => m[1]!));
    expect(keys.size).toBeGreaterThan(25);
    for (const k of keys) expect(() => t(`admin.content.fields.${k}`), k).not.toThrow();
  });

  it('has wording for every content error code the API can return', () => {
    const codes = [
      'page_slug_taken', 'page_empty', 'page_not_legal', 'guide_exists', 'guide_empty', 'media_in_use', 'media_not_found', 'media_alt_text', 'banner_link_incomplete', 'banner_window_invalid',
      'redirect_exists', 'redirect_loop', 'redirect_chain_too_long', 'redirect_path_reserved', 'content_status_unchanged', 'content_not_found', 'version_conflict', 'race_not_found',
    ];
    for (const code of codes) expect(catalogueError({ status: 409, body: { code } }), code).not.toBe(t('admin.common.error'));
  });

  it('describes every kind of row in words, including a row with missing fields', () => {
    for (const kind of ADMIN_KINDS) {
      const row = { id: 'x', version: 0, ...contentInitial(kind), label: 'L', slug: 's', question: 'Q', message: 'M', fromPath: '/a', toPath: '/b', status: 'published', enabled: true, location: 'header', race: { slug: 'r' } };
      expect(summaryOf(kind, row as never), kind).not.toBe('');
      expect(() => summaryOf(kind, { id: 'x', version: 0 } as never)).not.toThrow();
    }
  });

  it('knows which kinds are published, matching the API', () => {
    for (const k of CONTENT_KINDS) expect(HAS_STATUS[k]).toBe(k !== 'media');
    expect(HAS_STATUS.redirects).toBe(false);
  });
});
