import enAU from '../../messages/en-AU.json';
import esES from '../../messages/es-ES.json';
import { brand } from '@mt/shared/brand';
import { DEFAULT_LOCALE, localePath, type Locale } from './locales';

// The translation layer: every user-facing string comes from messages/<locale>.json. A locale is added by adding a file,
// registering the tag in `locales.ts` and listing the catalogue here (the type makes a missing entry a build error).
// A translation may be partial: a key a language lacks falls back to the default language, never to a blank.
type Json = { [key: string]: string | Json };
const catalogues: Record<Locale, Json> = { 'en-AU': enAU, 'es-ES': esES };
export { DEFAULT_LOCALE };
export type { Locale };

// Server components set the language of the current request (see `locale-server.ts`); everything else uses the default.
let requestLocale: () => Locale = () => DEFAULT_LOCALE;
/** Called once by `locale-server.ts`, in the server component layer only. */
export function setLocaleResolver(resolver: () => Locale): void {
  requestLocale = resolver;
}
/** The language `t()` uses when none is given. */
export const currentLocale = (): Locale => requestLocale();

/** A site path in the request's language: `/races` for the default, `/es-ES/races` for another. */
export const lp = (path: string): string => localePath(path, currentLocale());

function lookup(locale: Locale, key: string): string | undefined {
  let node: string | Json | undefined = catalogues[locale];
  for (const part of key.split('.')) {
    node = typeof node === 'object' ? node[part] : undefined;
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Look up a message. `{brand}` is always available (the brand name comes from the single brand
 * configuration file, never from the catalogue); other `{name}` placeholders come from `params`.
 */
export function t(key: string, params: Record<string, string | number> = {}, locale: Locale = currentLocale()): string {
  const node = lookup(locale, key) ?? lookup(DEFAULT_LOCALE, key);
  if (node === undefined) throw new Error(`Missing message: ${key}`);
  const values: Record<string, string | number> = { brand: brand.name, ...params };
  return node.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`Missing parameter "${name}" for message: ${key}`);
    return String(v);
  });
}

/** The raw catalogue, for tests that check every key. */
export function messageCatalogue(locale: Locale = DEFAULT_LOCALE): Json {
  return catalogues[locale];
}
