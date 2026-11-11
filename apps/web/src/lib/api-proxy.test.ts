import { describe, expect, it } from 'vitest';
import { apiUrl, forwardHeaders, responseHeaders } from './api-proxy';

describe('web proxy to the API', () => {
  it('web_proxy_forwards_only_allowed_headers, both ways', () => {
    const incoming = new Headers({
      cookie: 'mt_staff_session=abc', origin: 'http://localhost:3000', 'x-mt-csrf': '1', 'content-type': 'application/json',
      authorization: 'Bearer stolen', host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-request-id': 'req-12345678',
    });
    const out = forwardHeaders(incoming, 0);
    expect([...out.keys()].sort()).toEqual(['content-type', 'cookie', 'origin', 'x-mt-csrf', 'x-request-id']);
    const res = new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'a=1; HttpOnly', server: 'x', 'x-powered-by': 'y', 'retry-after': '3' } });
    const back = responseHeaders(res);
    expect(back.get('server')).toBeNull();
    expect(back.get('x-powered-by')).toBeNull();
    expect(back.getSetCookie()).toEqual(['a=1; HttpOnly']);
    expect(back.get('retry-after')).toBe('3');
  });

  it('spoofed_forwarded_for_via_web_proxy_ignored', () => {
    const spoofed = new Headers({ 'x-forwarded-for': '198.51.100.7' });
    expect(forwardHeaders(spoofed, 0).get('x-forwarded-for')).toBeNull();
    // Behind one trusted proxy, only the address that proxy appended counts.
    const behindOne = new Headers({ 'x-forwarded-for': '198.51.100.7, 203.0.113.20' });
    expect(forwardHeaders(behindOne, 1).get('x-forwarded-for')).toBe('203.0.113.20');
  });

  it('only builds URLs under the API root', () => {
    expect(apiUrl('http://api:4000', ['auth', 'staff', 'sign-in'], '')?.toString()).toBe('http://api:4000/auth/staff/sign-in');
    expect(apiUrl('http://api:4000', ['admin', 'audit'], '?entityType=Role')?.toString()).toBe('http://api:4000/admin/audit?entityType=Role');
    for (const bad of [['..', 'x'], ['a%2Fb'], ['a/b'], [], ['.']]) expect(apiUrl('http://api:4000', bad, '')).toBeNull();
  });
});
