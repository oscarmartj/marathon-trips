import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALE_NAMES, REGISTERED_LOCALES, enabledLocales, isEnabled, localePath, openGraphLocale, splitLocale } from './locales';
import { routeLocale } from './locale-routing';

describe('which languages are served', () => {
  it('serves only the default language unless others are named', () => {
    expect(enabledLocales('')).toEqual(['en-AU']);
    expect(enabledLocales(undefined)).toEqual(['en-AU']);
  });
  it('adds registered languages, default first, and ignores unknown or misspelt ones', () => {
    expect(enabledLocales('es-ES')).toEqual(['en-AU', 'es-ES']);
    expect(enabledLocales(' es-ES , fr-FR, en_AU ')).toEqual(['en-AU', 'es-ES']);
    expect(enabledLocales('es-ES,es-ES')).toEqual(['en-AU', 'es-ES']);
  });
  it('treats a registered but not enabled language as not served', () => {
    expect(isEnabled('es-ES', '')).toBe(false);
    expect(isEnabled('es-ES', 'es-ES')).toBe(true);
    expect(isEnabled('xx-XX', 'xx-XX')).toBe(false);
  });
  it('names every registered language in itself', () => {
    for (const l of REGISTERED_LOCALES) expect(LOCALE_NAMES[l].length).toBeGreaterThan(0);
  });
});

describe('addresses', () => {
  it('has no prefix for the default language and the tag for the others', () => {
    expect(localePath('/races', DEFAULT_LOCALE)).toBe('/races');
    expect(localePath('/', DEFAULT_LOCALE)).toBe('/');
    expect(localePath('/races/x?page=2', 'es-ES')).toBe('/es-ES/races/x?page=2');
    expect(localePath('/', 'es-ES')).toBe('/es-ES');
  });
  it('leaves outside links and protocol-relative addresses alone', () => {
    expect(localePath('https://example.com/a', 'es-ES')).toBe('https://example.com/a');
    expect(localePath('//evil.example/a', 'es-ES')).toBe('//evil.example/a');
  });
  it('splits a registered prefix off, and only a registered one', () => {
    expect(splitLocale('/es-ES/races')).toEqual({ locale: 'es-ES', rest: '/races' });
    expect(splitLocale('/es-ES')).toEqual({ locale: 'es-ES', rest: '/' });
    expect(splitLocale('/fr-FR/races')).toEqual({ locale: null, rest: '/fr-FR/races' });
    expect(splitLocale('/races/es-ES')).toEqual({ locale: null, rest: '/races/es-ES' });
  });
  it('writes Open Graph locales with an underscore', () => {
    expect(openGraphLocale('es-ES')).toBe('es_ES');
  });
});

describe('routing a page request', () => {
  const one = ['en-AU'] as const;
  const two = ['en-AU', 'es-ES'] as const;
  it('serves the default language from underneath, without changing the address', () => {
    expect(routeLocale('/races', undefined, one)).toEqual({ kind: 'rewrite', to: '/en-AU/races' });
    expect(routeLocale('/', undefined, one)).toEqual({ kind: 'rewrite', to: '/en-AU' });
  });
  it('sends the written-out default language back to the plain address and remembers it', () => {
    expect(routeLocale('/en-AU/races', 'es-ES', two)).toEqual({ kind: 'redirect', to: '/races', remember: 'en-AU' });
    expect(routeLocale('/en-AU', undefined, one)).toEqual({ kind: 'redirect', to: '/', remember: 'en-AU' });
  });
  it('serves an enabled language at its prefix and remembers it', () => {
    expect(routeLocale('/es-ES/races', undefined, two)).toEqual({ kind: 'rewrite', to: '/es-ES/races', remember: 'es-ES' });
  });
  it('lets a language that is not enabled through, for the layout to answer 404', () => {
    expect(routeLocale('/es-ES/races', undefined, one)).toEqual({ kind: 'pass' });
  });
  it('keeps a returning visitor in their language on plain addresses, only while it is enabled', () => {
    expect(routeLocale('/races', 'es-ES', two)).toEqual({ kind: 'rewrite', to: '/es-ES/races' });
    expect(routeLocale('/', 'es-ES', two)).toEqual({ kind: 'rewrite', to: '/es-ES' });
    expect(routeLocale('/races', 'es-ES', one)).toEqual({ kind: 'rewrite', to: '/en-AU/races' });
    expect(routeLocale('/races', 'garbage', two)).toEqual({ kind: 'rewrite', to: '/en-AU/races' });
  });
  it('never moves the site-wide share image into a language', () => {
    expect(routeLocale('/opengraph-image', 'es-ES', two)).toEqual({ kind: 'pass' });
    expect(routeLocale('/opengraph-image-abc123', undefined, two)).toEqual({ kind: 'pass' });
  });
});
