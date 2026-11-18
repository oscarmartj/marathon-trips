import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

/** A header rule of next.config.mjs. */
export type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

export const headerRules = async (): Promise<HeaderRule[]> => (await import('../../next.config.mjs' as string)).headerRules();

/**
 * The headers next.config.mjs gives an address, evaluated as Next.js does: every rule whose source matches the original
 * address applies, in order, and for the same header the last one wins (task 8.5).
 */
export async function configHeadersFor(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await headerRules()) {
    if (getPathMatch(r.source, { strict: true, removeUnnamedParams: true, regexModifier: (s: string) => s })(path) === false) continue;
    for (const h of r.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}
