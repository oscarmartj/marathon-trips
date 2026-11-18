import { describe, expect, it } from 'vitest';
import { messageCatalogue, t } from './i18n';
import { REGISTERED_LOCALES } from './locales';

describe('t', () => {
  it('returns an en-AU message with the brand name filled in from the brand config', () => {
    expect(t('home.title')).toBe('Marathon Trips');
  });
  it('fills named parameters', () => {
    expect(t('races.detail.title', { name: 'Sample Marathon' })).toBe('Sample Marathon');
  });
  it('throws on a missing key rather than rendering a blank', () => {
    expect(() => t('home.nope')).toThrow(/Missing message/);
  });
  it('throws on a missing parameter', () => {
    expect(() => t('races.detail.title')).toThrow(/Missing parameter/);
  });
});

type Json = { [key: string]: string | Json };
const leaves = (node: Json, prefix = ''): Array<[string, string]> =>
  Object.entries(node).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('languages', () => {
  const english = new Map(leaves(messageCatalogue('en-AU')));

  it.each(REGISTERED_LOCALES.filter((l) => l !== 'en-AU'))('%s only has keys that English has, with the same {placeholders} and no blanks', (locale) => {
    for (const [key, text] of leaves(messageCatalogue(locale))) {
      expect(english.has(key), `${locale} has a key English lacks: ${key}`).toBe(true);
      expect(text.trim().length, `${locale} ${key} is blank`).toBeGreaterThan(0);
      expect(placeholders(text), `${locale} ${key} placeholders`).toEqual(placeholders(english.get(key)!));
    }
  });

  it('uses a translation when there is one', () => {
    expect(t('nav.races', {}, 'es-ES')).toBe('Carreras');
    expect(t('races.detail.title', { name: 'Maratón de Sevilla' }, 'es-ES')).toBe('Maratón de Sevilla');
  });

  it('falls back to English for a key a translation lacks, never to a blank or an error', () => {
    expect(t('nav.account', {}, 'es-ES')).toBe(t('nav.account', {}, 'en-AU'));
  });

  it('still throws for a key that exists in no language', () => {
    expect(() => t('nav.nope', {}, 'es-ES')).toThrow(/Missing message/);
  });

  it('keeps the brand name out of the catalogues in every language', () => {
    expect(t('footer.rights', {}, 'es-ES')).toBe('Marathon Trips. Todos los derechos reservados.');
  });
});
