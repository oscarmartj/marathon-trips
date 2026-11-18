import { cache } from 'react';
import { DEFAULT_LOCALE, isRegistered, type Locale } from './locales';
import { setLocaleResolver } from './i18n';

/**
 * The language of the request being rendered, for server components. Layouts and pages render separately, so each one
 * calls `setRequestLocale(params.locale)` (or `localeFromParams`) before it uses `t()`; the same pattern next-intl uses.
 * In a server render `cache` gives one value per request, so concurrent requests never see each other's language. Unit
 * tests render outside a request, where `cache` does not remember anything, so they keep the value in a variable instead
 * (never in a real server: the variable would be shared between requests).
 */
const IN_TESTS = process.env.NODE_ENV === 'test';
const perRequest = cache((): { locale: Locale } => ({ locale: DEFAULT_LOCALE }));
let testLocale: Locale = DEFAULT_LOCALE;

setLocaleResolver(() => (IN_TESTS ? testLocale : perRequest().locale));

export function setRequestLocale(locale: string | undefined): Locale {
  const resolved = isRegistered(locale) ? locale : DEFAULT_LOCALE;
  if (IN_TESTS) testLocale = resolved;
  else perRequest().locale = resolved;
  return resolved;
}

/** Read the language from a page's route params and set it for the rest of the render. Tests that call a page directly pass no params: the default language. */
export async function localeFromParams(params?: Promise<{ locale?: string }>): Promise<Locale> {
  return setRequestLocale(params ? (await params).locale : undefined);
}
