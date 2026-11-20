/**
 * The web app is the API's only public door (plan 4.1, decision 2 of the 0.3 plan): the browser calls /api/* on the
 * web origin and this proxy forwards to API_BASE_URL. Only listed headers cross, in both directions (T16, M1).
 */
// idempotency-key: booking requests (task 2.4) carry one, so a retried submission makes one request.
export const FORWARD_REQUEST_HEADERS = ['cookie', 'origin', 'x-mt-csrf', 'content-type', 'accept', 'user-agent', 'x-request-id', 'idempotency-key'] as const;
// content-disposition: a customer's booking documents download as files (task 5.1).
// Task 8.5 (S-08): the API's own security headers reach the browser too (nosniff, no framing, no Referer, and its strict
// Content-Security-Policy), instead of the page policy; see `apiSecurityHeader` for the one exception.
export const FORWARD_RESPONSE_HEADERS = [
  'content-type', 'retry-after', 'cache-control', 'x-request-id', 'content-disposition', 'x-row-count',
  'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy',
] as const;

/** Set when the proxy forwards a client address, so the API can check that address (S-04); never from the browser. */
export const PROXIED_HEADER = 'x-mt-proxied';

/** Largest request body the proxy forwards (the API's JSON limit is the same). */
export const MAX_BODY_BYTES = 100 * 1024;

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
    // Only a request that came through the proxies in front (Caddy) has a client address to check, so it is marked as soon
    // as any X-Forwarded-For arrives: even when WEB_TRUSTED_PROXY_HOPS is more than the real proxies and no client comes
    // out, so the API sees the web container's address and the monitor says so (review round 2). A call made inside the
    // container (a health check) carries none and is not marked (review round 1).
    if (chain.length > 0) out.set(PROXIED_HEADER, '1');
  }
  return out;
}

export function responseHeaders(res: Response): Headers {
  const out = new Headers();
  const pdf = (res.headers.get('content-type') ?? '').toLowerCase().startsWith('application/pdf');
  for (const name of FORWARD_RESPONSE_HEADERS) {
    // A PDF shown in the browser's own viewer (the template preview, task 7.x) is not given the API's `default-src 'none'`
    // policy: some viewers run inside the document and would be blocked. nosniff, no framing and no-store still apply.
    if (name === 'content-security-policy' && pdf) continue;
    const v = res.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  for (const c of res.headers.getSetCookie()) out.append('set-cookie', c);
  return out;
}

/** The proxy's own answers (bad path, too large, API unreachable): the API's error shape, never cached or sniffed (S-09). */
export function proxyError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, {
    status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' },
  });
}

export class BodyTooLarge extends Error {}

/**
 * Reads a request body up to `max` bytes. A declared Content-Length above it is refused before anything is read; a body
 * without one (chunked) is counted as it arrives and dropped at the first byte past the limit (S-09). Nothing larger is
 * ever held in memory.
 */
export async function readCappedBody(req: Request, max: number = MAX_BODY_BYTES): Promise<ArrayBuffer | undefined> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new BodyTooLarge();
  if (!req.body) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export const trustedHops = (): number => {
  const n = Number(process.env.WEB_TRUSTED_PROXY_HOPS ?? '0');
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
};

export const apiBase = (): string => process.env.API_BASE_URL ?? 'http://localhost:4000';
