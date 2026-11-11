import enAU from '../../messages/en-AU.json';

// The translation layer: every user-facing string comes from messages/<locale>.json.
// Only en-AU exists for now; a locale is added by adding a file and registering it here.
const catalogues = { 'en-AU': enAU } as const;
export type Locale = keyof typeof catalogues;
export const DEFAULT_LOCALE: Locale = 'en-AU';

type Json = { [key: string]: string | Json };

export function t(key: string, locale: Locale = DEFAULT_LOCALE): string {
  let node: string | Json | undefined = catalogues[locale] as Json;
  for (const part of key.split('.')) {
    node = typeof node === 'object' ? node[part] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`Missing message: ${key}`);
  return node;
}
