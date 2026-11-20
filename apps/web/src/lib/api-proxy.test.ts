import { describe, expect, it } from 'vitest';
import { BodyTooLarge, MAX_BODY_BYTES, apiUrl, forwardHeaders, proxyError, readCappedBody, responseHeaders } from './api-proxy';

describe('web proxy to the API', () => {
  it('web_proxy_forwards_only_allowed_headers, both ways', () => {
    const incoming = new Headers({
      cookie: 'mt_staff_session=abc', origin: 'http://localhost:3000', 'x-mt-csrf': '1', 'content-type': 'application/json',
      authorization: 'Bearer stolen', host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-request-id': 'req-12345678',
    });
    const out = forwardHeaders(incoming, 0);
    expect([...out.keys()].sort()).toEqual(['content-type', 'cookie', 'origin', 'x-mt-csrf', 'x-request-id']);
    // Task 8.5: a browser cannot set the proxy's marker.
    expect(forwardHeaders(new Headers({ 'x-mt-proxied': '1' }), 0).get('x-mt-proxied')).toBeNull();
    expect(forwardHeaders(new Headers({ 'x-mt-proxied': '1' }), 1).get('x-mt-proxied')).toBeNull();
    const res = new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'a=1; HttpOnly', server: 'x', 'x-powered-by': 'y', 'retry-after': '3' } });
    const back = responseHeaders(res);
    expect(back.get('server')).toBeNull();
    expect(back.get('x-powered-by')).toBeNull();
    expect(back.getSetCookie()).toEqual(['a=1; HttpOnly']);
    expect(back.get('retry-after')).toBe('3');
  });

  it('forwards the row count of a CSV download (task 6.6)', () => {
    expect(responseHeaders(new Response('', { headers: { 'x-row-count': '12', 'x-secret-thing': 'no' } })).get('x-row-count')).toBe('12');
    expect(responseHeaders(new Response('', { headers: { 'x-secret-thing': 'no' } })).get('x-secret-thing')).toBeNull();
  });

  it('spoofed_forwarded_for_via_web_proxy_ignored', () => {
    const spoofed = new Headers({ 'x-forwarded-for': '198.51.100.7' });
    expect(forwardHeaders(spoofed, 0).get('x-forwarded-for')).toBeNull();
    // Behind one trusted proxy, only the address that proxy appended counts.
    const behindOne = new Headers({ 'x-forwarded-for': '198.51.100.7, 203.0.113.20' });
    expect(forwardHeaders(behindOne, 1).get('x-forwarded-for')).toBe('203.0.113.20');
  });

  it('forward_headers_passes_authorization only for an API key (task 8.4)', () => {
    const token = `mtk_${'a'.repeat(12)}_${'B'.repeat(43)}`;
    expect(forwardHeaders(new Headers({ authorization: `Bearer ${token}` }), 0).get('authorization')).toBe(`Bearer ${token}`);
  });

  it('forward_headers_drops_non_mtk_authorization', () => {
    for (const v of ['Bearer stolen', 'Basic dXNlcjpwdw==', `Bearer mtk_${'a'.repeat(12)}_${'B'.repeat(42)}`, `bearer mtk_${'a'.repeat(12)}_${'B'.repeat(43)}`, `Bearer mtk_${'a'.repeat(12)}_${'B'.repeat(43)} extra`]) {
      expect(forwardHeaders(new Headers({ authorization: v }), 0).get('authorization'), v).toBeNull();
    }
  });

  it('only builds URLs under the API root', () => {
    expect(apiUrl('http://api:4000', ['auth', 'staff', 'sign-in'], '')?.toString()).toBe('http://api:4000/auth/staff/sign-in');
    expect(apiUrl('http://api:4000', ['admin', 'audit'], '?entityType=Role')?.toString()).toBe('http://api:4000/admin/audit?entityType=Role');
    for (const bad of [['..', 'x'], ['a%2Fb'], ['a/b'], [], ['.']]) expect(apiUrl('http://api:4000', bad, '')).toBeNull();
  });

  it('forwards the API security headers, except the API CSP on a PDF shown in the browser (task 8.5, S-08)', () => {
    const api = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' };
    const json = responseHeaders(new Response('{}', { headers: { ...api, 'content-type': 'application/json' } }));
    for (const [k, v] of Object.entries(api)) expect(json.get(k), k).toBe(v);
    const pdf = responseHeaders(new Response('%PDF', { headers: { ...api, 'content-type': 'application/pdf' } }));
    expect(pdf.get('content-security-policy')).toBeNull();
    expect(pdf.get('x-content-type-options')).toBe('nosniff');
    expect(pdf.get('x-frame-options')).toBe('DENY');
  });

  it("the proxy's own answers are never cached or sniffed (S-09)", async () => {
    const r = proxyError(502, 'api_unavailable', 'x');
    expect(r.status).toBe(502);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await r.json()).toEqual({ code: 'api_unavailable', message: 'x' });
  });

  it('refuses a body over the limit by its Content-Length before reading it, and a chunked one as it arrives (S-09)', async () => {
    let pulled = 0;
    const endless = () => new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(16 * 1024)); } });
    const declared = new Request('http://x/api/a', { method: 'POST', body: endless(), headers: { 'content-length': String(1024 ** 3) }, duplex: 'half' } as RequestInit);
    await expect(readCappedBody(declared)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(pulled).toBeLessThanOrEqual(1); // the stream's own read-ahead, never the body
    pulled = 0;
    const chunked = new Request('http://x/api/a', { method: 'POST', body: endless(), duplex: 'half' } as RequestInit);
    await expect(readCappedBody(chunked)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(pulled * 16 * 1024).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * 16 * 1024);
    const bad = new Request('http://x/api/a', { method: 'POST', body: 'x', headers: { 'content-length': 'abc' } });
    await expect(readCappedBody(bad)).rejects.toBeInstanceOf(BodyTooLarge);
    const ok = new Request('http://x/api/a', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(new TextDecoder().decode(await readCappedBody(ok))).toBe('{"a":1}');
    const exact = new Request('http://x/api/a', { method: 'POST', body: new Uint8Array(MAX_BODY_BYTES) });
    expect((await readCappedBody(exact))!.byteLength).toBe(MAX_BODY_BYTES);
  });

  it('marks a request only when it forwards a client address: the health check from inside the container is not marked (S-04)', () => {
    const viaCaddy = forwardHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }), 1);
    expect(viaCaddy.get('x-mt-proxied')).toBe('1');
    expect(viaCaddy.get('x-forwarded-for')).toBe('203.0.113.7');
    // deploy/docker-compose.prod.yml: the web healthcheck calls localhost:3000/api/health with no X-Forwarded-For.
    const healthcheck = forwardHeaders(new Headers({ 'user-agent': 'node' }), 1);
    expect(healthcheck.get('x-mt-proxied')).toBeNull();
    expect(healthcheck.get('x-forwarded-for')).toBeNull();
    // Review round 2: more hops configured than real proxies (2 with only Caddy): no client comes out, but the request
    // is still marked, so the API counts the web container's private address and the monitor reports it.
    const tooMany = forwardHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }), 2);
    expect(tooMany.get('x-forwarded-for')).toBeNull();
    expect(tooMany.get('x-mt-proxied')).toBe('1');
    expect(forwardHeaders(new Headers({ 'x-forwarded-for': ' , ' }), 1).get('x-mt-proxied')).toBeNull();
    // Without trusted proxies (development) nothing is forwarded or marked.
    expect(forwardHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }), 0).get('x-mt-proxied')).toBeNull();
  });
});
