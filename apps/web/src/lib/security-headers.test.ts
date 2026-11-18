import { afterEach, describe, expect, it, vi } from 'vitest';
import { configHeadersFor as headersFor, headerRules as rules } from '@/test/next-headers';
import { contentSecurityPolicy, usesNonce } from './csp';
import { routeLocale } from './locale-routing';
import { proxy } from '@/proxy';

// Task 8.5 (S-03, S-12): security headers of every route class, evaluated the way Next.js does it: each rule's source is
// matched against the original address and, for the same header, the last matching rule wins.
describe('next.config.mjs header rules (S-03)', () => {
  it.each(['/', '/races', '/races/gold-coast', '/account', '/account/privacy', '/admin', '/admin/bookings/1', '/es-ES/races', '/_next/static/x.js', '/no-such-page.php'])('%s gets the page headers', async (path) => {
    const h = await headersFor(path);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toMatch(/camera=\(\)/);
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['content-security-policy']).toBeUndefined(); // one source per route: proxy.ts
  });

  it.each(['/pay', '/pay/return', '/account/sign-in/verify', '/unsubscribe', '/alerts/confirm', '/alerts/unsubscribe', '/es-ES/pay', '/es-ES/pay/return', '/es-ES/account/sign-in/verify', '/es-ES/unsubscribe', '/admin/enrol'])(
    '%s (a token page, with or without a language prefix) sends no Referer and still cannot be framed',
    async (path) => {
      const h = await headersFor(path);
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['x-content-type-options']).toBe('nosniff');
    },
  );

  it.each(['/api/auth/staff/session', '/api', '/api/health'])('%s (the API proxy) gets none: the API sends its own', async (path) => {
    expect(await headersFor(path)).toEqual({});
  });

  it('a token page rule placed before the page rule would be overridden: the order is part of the contract', async () => {
    const all = await rules();
    const page = all.findIndex((r) => r.headers.some((h) => h.key === 'X-Content-Type-Options'));
    const token = all.findIndex((r) => r.source === '/pay');
    expect(page).toBe(0);
    expect(token).toBeGreaterThan(page);
  });
});

describe('page Content-Security-Policy (S-03)', () => {
  const request = (path: string, method = 'GET') => ({
    headers: new Headers(), method, nextUrl: new URL(`http://localhost:3000${path}`), url: `http://localhost:3000${path}`,
    cookies: { get: () => undefined },
  });
  afterEach(() => vi.unstubAllGlobals());
  const stubApi = () => vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));

  it('production policy: no eval, no foreign scripts, no plugins, no framing, no <base> or form hijacking', () => {
    const csp = contentSecurityPolicy({ dev: false });
    for (const d of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "connect-src 'self'"]) expect(csp).toContain(d);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('ws:');
    expect(contentSecurityPolicy({ dev: true })).toContain("'unsafe-eval'");
    const nonced = contentSecurityPolicy({ nonce: 'abc', dev: false });
    expect(nonced).toMatch(/script-src 'self' 'nonce-abc' 'strict-dynamic'(;|$)/);
    expect(nonced).not.toContain("'unsafe-inline' ;");
    expect(/script-src[^;]*'unsafe-inline'/.test(nonced)).toBe(false);
  });

  it.each([
    ['/admin', true], ['/admin/bookings/123', true], ['/admin/sign-in', false], ['/admin/enrol', false], ['/account', true], ['/account/bookings/MT-ABC123', true],
    ['/account/privacy', false], ['/account/sign-in', false], ['/quotes/Q-1', true], ['/trips/requests/MT-ABC123', true], ['/waitlist/x', true], ['/checkout/MT-ABC123', true],
    ['/checkout', false], ['/races', false], ['/', false],
  ] as const)('%s uses the nonce policy: %s', (path, nonce) => expect(usesNonce(path)).toBe(nonce));

  it('the proxy sends the static policy on a static page and a fresh nonce on each dynamic one, also to Next.js in the request', async () => {
    stubApi();
    const page = await proxy(request('/races') as never);
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'self' 'unsafe-inline'/);
    const a = await proxy(request('/account') as never);
    const b = await proxy(request('/account') as never);
    const nonceOf = (r: Response) => /'nonce-([^']+)'/.exec(r.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    // Next.js reads the nonce from the request headers it is handed (x-middleware-request-*).
    expect(a.headers.get('x-middleware-request-content-security-policy')).toBe(a.headers.get('content-security-policy'));
    const es = await proxy(request('/es-ES/account') as never);
    expect(es.headers.get('content-security-policy') ?? '').toBeTruthy();
  });

  it('the panel gets its policy (and no language or redirect handling); its sign-in page the static one', async () => {
    stubApi();
    const panel = await proxy(request('/admin/bookings') as never);
    expect(panel.headers.get('content-security-policy')).toMatch(/'nonce-/);
    expect(panel.headers.get('x-middleware-rewrite')).toBeNull();
    const signIn = await proxy(request('/admin/sign-in') as never);
    expect(signIn.headers.get('content-security-policy')).toMatch(/'unsafe-inline'/);
    const post = await proxy(request('/races', 'POST') as never);
    expect(post.headers.get('content-security-policy')).toBeTruthy();
  });
});

describe('language redirects stay on this site (S-12)', () => {
  it.each(['/en-AU//other.example', '/en-AU//other.example/x', '/en-AU/\\other.example', '/en-AU/\\/other.example'])('%s redirects to a path here', (path) => {
    const r = routeLocale(path, undefined, ['en-AU']);
    expect(r.kind).toBe('redirect');
    const to = (r as { to: string }).to;
    expect(to.startsWith('/')).toBe(true);
    expect(/^[\\/]{2}/.test(to)).toBe(false);
    expect(new URL(to, 'https://trips.example.com').host).toBe('trips.example.com');
  });
});
