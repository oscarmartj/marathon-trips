/**
 * The web app is the API's only public door (plan 4.1, decision 2 of the 0.3 plan): the browser calls /api/* on the
 * web origin and this proxy forwards to API_BASE_URL. Only listed headers cross, in both directions (T16, M1).
 */
// idempotency-key: booking requests (task 2.4) carry one, so a retried submission makes one request.
export const FORWARD_REQUEST_HEADERS = ['cookie', 'origin', 'x-mt-csrf', 'content-type', 'accept', 'user-agent', 'x-request-id', 'idempotency-key'] as const;
export const FORWARD_RESPONSE_HEADERS = ['content-type', 'retry-after', 'cache-control', 'x-request-id'] as const;

export const API_KEY_AUTHORIZATION = /^Bearer mtk_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The API URL for a proxied path, or null if a segment could escape the API's root (`..`, encoded slashes). */
export function apiUrl(base: string, segments: readonly string[], search: string): URL | null {
  if (segments.length === 0 || segments.some((s) => !SEGMENT.test(s) || s === '.' || s === '..')) return null;
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${segments.join('/')}`;
  url.search = search;
  return url;
}

/**
 * Request headers for the API. The browser's X-Forwarded-For is never passed on (it could be anything). With
 * `trustedHops` proxies in front of the web app (WEB_TRUSTED_PROXY_HOPS, set by the hosting task), the client address
 * is the entry those proxies appended; with 0 (default) no address is sent and the API sees the web server.
 */
export function forwardHeaders(incoming: Headers, trustedHops: number): Headers {
  const out = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = incoming.get(name);
    if (v !== null) out.set(name, v);
  }
  // Task 8.4: API keys reach the API through this door too, but only in their own shape; any other Authorization
  // (Basic, a third-party token, a browser extension's header) is dropped here.
  const authorization = incoming.get('authorization');
  if (authorization !== null && API_KEY_AUTHORIZATION.test(authorization)) out.set('authorization', authorization);
  if (trustedHops > 0) {
    const chain = (incoming.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const client = chain[chain.length - trustedHops];
    if (client) out.set('x-forwarded-for', client);
  }
  return out;
}

export function responseHeaders(res: Response): Headers {
  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
  return out;
}

export const trustedHops = (): number => {
  const n = Number(process.env.WEB_TRUSTED_PROXY_HOPS ?? '0');
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
};

export const apiBase = (): string => process.env.API_BASE_URL ?? 'http://localhost:4000';
