import { apiBase } from './api-proxy';

/** A redirect staff set up in the content manager (apps/api/src/modules/content). */
export interface RedirectRule { fromPath: string; toPath: string; statusCode: number }

/** Paths the redirects never touch: the panel, the API proxy, build output and files. */
const SKIPPED = /^\/(admin|api|_next)(\/|$)|\.[A-Za-z0-9]{1,8}$/;
const ALLOWED_CODES: ReadonlySet<number> = new Set([301, 302, 307, 308]);

const normalise = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);

/** The redirect for a path, or null. Trailing slashes do not matter; a rule that points at its own path is ignored. */
export function findRedirect(rules: readonly RedirectRule[], pathname: string, search = ''): { location: string; status: number } | null {
  if (SKIPPED.test(pathname)) return null;
  const path = normalise(pathname);
  const rule = rules.find((r) => r.fromPath === path);
  if (!rule || !ALLOWED_CODES.has(rule.statusCode)) return null;
  const target = rule.toPath;
  if (!/^(\/(?!\/)|https:\/\/)/.test(target)) return null;
  if (target.startsWith('/') && normalise(target.split(/[?#]/, 1)[0]!) === path) return null;
  // The visitor's query string travels with them unless the target sets its own.
  const location = target.includes('?') || !search ? target : `${target}${search}`;
  return { location, status: rule.statusCode };
}

const FRESH_MS = 30_000;
const RETRY_MS = 10_000;
let cache: { rules: RedirectRule[]; until: number } | null = null;

/**
 * The enabled redirects, kept in memory for 30 seconds so most requests cost nothing (the proxy runs on every request, and
 * the framework's fetch cache does not apply there). When the API cannot be reached the last list stays in use and is
 * tried again in 10 seconds; with no list yet, no redirects apply.
 */
export async function loadRedirects(now = Date.now(), fetchFn: typeof fetch = fetch): Promise<RedirectRule[]> {
  if (cache && cache.until > now) return cache.rules;
  try {
    const res = await fetchFn(`${apiBase()}/content/redirects`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { items?: RedirectRule[] };
    cache = { rules: Array.isArray(body.items) ? body.items : [], until: now + FRESH_MS };
  } catch {
    cache = { rules: cache?.rules ?? [], until: now + RETRY_MS };
  }
  return cache.rules;
}

/** For tests. */
export function resetRedirectCache(): void {
  cache = null;
}
