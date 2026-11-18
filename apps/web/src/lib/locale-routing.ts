import { DEFAULT_LOCALE, isRegistered, splitLocale, type Locale } from './locales';

/** What the proxy does with a page request, decided from the path, the remembered language and the enabled languages. */
export type LocaleRoute =
  | { kind: 'pass' }
  | { kind: 'redirect'; to: string; remember: Locale }
  | { kind: 'rewrite'; to: string; remember?: Locale };

/** Route files that live outside `app/[locale]` and so must never be rewritten into it. */
const ROOT_ROUTES = /^\/(opengraph-image|twitter-image)(-[A-Za-z0-9]+)?$/;

/**
 * - `/en-AU/x` (the default language written out) goes back to `/x` and is remembered, so switching back to English works.
 * - `/es-ES/x` is served as is and remembered. A language that is not enabled is passed through: the layout answers 404.
 * - `/x` is served in the remembered language if it is enabled (a return visitor keeps their language through the many
 *   plain `/x` links), else in the default language. Crawlers carry no cookie, so each address they see is one language.
 */
export function routeLocale(pathname: string, remembered: string | undefined, enabled: readonly Locale[]): LocaleRoute {
  if (ROOT_ROUTES.test(pathname)) return { kind: 'pass' };
  const { locale, rest } = splitLocale(pathname);
  if (locale === DEFAULT_LOCALE) return { kind: 'redirect', to: rest, remember: DEFAULT_LOCALE };
  if (locale) return enabled.includes(locale) ? { kind: 'rewrite', to: pathname, remember: locale } : { kind: 'pass' };
  const chosen = isRegistered(remembered) && enabled.includes(remembered) ? remembered : DEFAULT_LOCALE;
  return { kind: 'rewrite', to: `/${chosen}${pathname === '/' ? '' : pathname}` };
}
