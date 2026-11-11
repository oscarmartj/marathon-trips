import enAU from '../../messages/en-AU.json';
import { brand } from '@mt/shared/brand';

// The translation layer: every user-facing string comes from messages/<locale>.json.
// Only en-AU exists for now; a locale is added by adding a file and registering it here.
const catalogues = { 'en-AU': enAU } as const;
export type Locale = keyof typeof catalogues;
export const DEFAULT_LOCALE: Locale = 'en-AU';

type Json = { [key: string]: string | Json };

/**
 * Look up a message. `{brand}` is always available (the brand name comes from the single brand
 * configuration file, never from the catalogue); other `{name}` placeholders come from `params`.
 */
export function t(key: string, params: Record<string, string | number> = {}, locale: Locale = DEFAULT_LOCALE): string {
  let node: string | Json | undefined = catalogues[locale] as Json;
  for (const part of key.split('.')) {
    node = typeof node === 'object' ? node[part] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`Missing message: ${key}`);
  const values: Record<string, string | number> = { brand: brand.name, ...params };
  return node.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`Missing parameter "${name}" for message: ${key}`);
    return String(v);
  });
}

/** The raw catalogue, for tests that check every key. */
export function messageCatalogue(locale: Locale = DEFAULT_LOCALE): Json {
  return catalogues[locale] as Json;
}
