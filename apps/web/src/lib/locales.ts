/**
 * Languages the site knows about and which of them it serves. No catalogue is imported here, so the proxy (which runs
 * on every request) can use it cheaply.
 *
 * Adding a language: write `messages/<tag>.json`, add the tag to `REGISTERED_LOCALES` and `LOCALE_NAMES` here, and
 * to the catalogue map in `i18n.ts` (typed, so forgetting it fails the build). Nothing in the data model changes:
 * content rows carry their own `locale` and catalogue names are keyed by locale. Serving it is then a setting,
 * `ENABLED_LOCALES`.
 */
export const DEFAULT_LOCALE = 'en-AU' as const;
export const REGISTERED_LOCALES = ['en-AU', 'es-ES'] as const;
export type Locale = (typeof REGISTERED_LOCALES)[number];

/** Each language written in itself, for the language switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { 'en-AU': 'English (Australia)', 'es-ES': 'Español (España)' };

export const LOCALE_COOKIE = 'mt_locale';

export const isRegistered = (value: string | undefined | null): value is Locale => !!value && (REGISTERED_LOCALES as readonly string[]).includes(value);

/** The languages being served: registered ones named in `ENABLED_LOCALES`, always including the default, default first. */
export function enabledLocales(env: string | undefined = process.env.ENABLED_LOCALES): Locale[] {
  const named = (env ?? '').split(',').map((s) => s.trim()).filter(isRegistered);
  return [DEFAULT_LOCALE, ...REGISTERED_LOCALES.filter((l) => l !== DEFAULT_LOCALE && named.includes(l))];
}

export const isEnabled = (value: string | undefined | null, env?: string): value is Locale => isRegistered(value) && enabledLocales(env).includes(value);

/** The URL prefix of a language: none for the default one. */
export const localePrefix = (locale: Locale): string => (locale === DEFAULT_LOCALE ? '' : `/${locale}`);

/** `/races` in a language: `/races` for the default, `/es-ES/races` otherwise. A path that is not a site path (outside links) is returned as is. */
export function localePath(path: string, locale: Locale): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  const prefix = localePrefix(locale);
  return path === '/' ? prefix || '/' : `${prefix}${path}`;
}

/** Split a request path into its language prefix (if it starts with a registered tag) and the rest. */
export function splitLocale(pathname: string): { locale: Locale | null; rest: string } {
  const m = /^\/([A-Za-z]{2,3}-[A-Za-z0-9]{2,8})(\/.*)?$/.exec(pathname);
  if (m && isRegistered(m[1])) return { locale: m[1], rest: m[2] || '/' };
  return { locale: null, rest: pathname };
}

/** `es-ES` -> `es_ES`, the form Open Graph uses. */
export const openGraphLocale = (locale: Locale): string => locale.replace('-', '_');
