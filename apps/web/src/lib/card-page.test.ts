// The card page of a card session (task 4.4, plan docs/plans/4.4-au-card-gateway.md, sections 10.2 to 10.4): what it
// renders and sends, and the route's own Content-Security-Policy. No network: the gateway's script is a mocked global.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_PAGE_FRAME_ORIGINS, CARD_SESSION_REF_PATTERN, PIN_CARD_FIELDS } from '@mt/shared';
import { CardPage } from '@/components/pay/card-page';
import { proxy } from '@/proxy';
import { CARD_FIELD_CONTAINERS, CARD_SESSION_REF, cardPageErrorKey, cardPageFailureKey, cardSubmitBody, loadScriptOnce } from './card-page';
import { contentSecurityPolicy, usesCardFields, usesNonce } from './csp';

const request = (path: string) => ({ headers: new Headers(), method: 'GET', nextUrl: new URL(`http://localhost:3000${path}`), url: `http://localhost:3000${path}`, cookies: { get: () => undefined } });
afterEach(() => vi.unstubAllGlobals());

describe('card page (task 4.4)', () => {
  it('card_data_never_reaches_api: the page declares no card input and posts only the session and the token', () => {
    expect(cardSubmitBody('cs_x', 'card_y')).toEqual({ ref: 'cs_x', cardToken: 'card_y' });
    const src = readFileSync(join(__dirname, '../components/pay/card-page.tsx'), 'utf8');
    expect(/<input|<select|<textarea/.test(src)).toBe(false);
    expect(/name=["'](number|cvc|expiry|card)/i.test(src)).toBe(false);
    expect(CARD_FIELD_CONTAINERS.map((c) => c.field)).toEqual(['name', 'number', 'expiry', 'cvc']);
    expect(CARD_SESSION_REF.source).toBe(CARD_SESSION_REF_PATTERN.source);
  });

  it('renders the loading state first; error, failure and status keys come from closed lists', () => {
    const html = renderToStaticMarkup(createElement(CardPage, { sessionRef: `cs_${'a'.repeat(32)}` }));
    expect(html).toContain('Getting your payment ready');
    expect([cardPageErrorKey(404, undefined), cardPageErrorKey(409, 'card_session_not_open'), cardPageErrorKey(409, 'booking_payment_under_review'), cardPageErrorKey(429, undefined), cardPageErrorKey(500, undefined)])
      .toEqual(['notFound', 'notOpen', 'underReview', 'tooMany', 'generic']);
    expect([cardPageFailureKey('card_declined'), cardPageFailureKey('card_not_authenticated'), cardPageFailureKey('provider_busy'), cardPageFailureKey('outcome_unknown')]).toEqual(['declined', 'notAuthenticated', 'busy', 'generic']);
    const messages = JSON.parse(readFileSync(join(__dirname, '../../messages/en-AU.json'), 'utf8')) as { cardPage: Record<string, unknown> };
    for (const k of ['notFound', 'notOpen', 'underReview', 'invalid', 'tooMany', 'checkCard', 'fieldsUnavailable', 'network', 'generic']) expect((messages.cardPage.errors as Record<string, string>)[k], k).toBeTruthy();
    for (const k of ['declined', 'notAuthenticated', 'busy', 'generic']) expect((messages.cardPage.failed as Record<string, string>)[k], k).toBeTruthy();
    // No accreditation or "official" claims in its copy.
    expect(/official|accredit|guarantee/i.test(JSON.stringify(messages.cardPage))).toBe(false);
  });

  it('loads only an https script, once', async () => {
    await expect(loadScriptOnce('http://cdn.example/x.js')).rejects.toThrow();
    await expect(loadScriptOnce('javascript:alert(1)')).rejects.toThrow();
    const appended: Array<{ src: string; listeners: Record<string, () => void>; dataset: Record<string, string> }> = [];
    const doc = {
      querySelector: () => (appended[0] ? appended[0] : null),
      createElement: () => {
        const el = { src: '', async: false, dataset: {} as Record<string, string>, listeners: {} as Record<string, () => void>, addEventListener(k: string, f: () => void) { this.listeners[k] = f; } };
        return el;
      },
      head: { appendChild: (el: (typeof appended)[number]) => appended.push(el) },
    } as unknown as Document;
    const p = loadScriptOnce(PIN_CARD_FIELDS.scriptUrl, doc);
    appended[0]!.listeners.load!();
    await p;
    expect(appended).toHaveLength(1);
    expect(appended[0]!.src).toBe(PIN_CARD_FIELDS.scriptUrl);
    await loadScriptOnce(PIN_CARD_FIELDS.scriptUrl, doc);
    expect(appended).toHaveLength(1);
  });
});

describe('card page Content-Security-Policy (task 4.4, section 10.3)', () => {
  it('csp_card_route_origins_match_manifest: only /pay/card/* allows the gateway, and only with a nonce', () => {
    expect(usesNonce('/pay/card/cs_abc')).toBe(true);
    expect(usesCardFields('/pay/card/cs_abc')).toBe(true);
    for (const p of ['/pay', '/pay/return', '/pay/card', '/pay/card/a/b', '/checkout/MT-1', '/account']) expect(usesCardFields(p), p).toBe(false);
    const card = contentSecurityPolicy({ nonce: 'n1', dev: false, cardFields: true });
    expect(card).toContain(`frame-src ${CARD_PAGE_FRAME_ORIGINS.join(' ')}`);
    expect(card).toMatch(/script-src 'self' 'nonce-n1' 'strict-dynamic' https:\/\/cdn\.pinpayments\.com(;|$)/);
    expect(card).toContain("default-src 'self'");
    expect(card).toContain("connect-src 'self'");
    expect(contentSecurityPolicy({ nonce: 'n1', dev: false })).toContain("frame-src 'none'");
    // Without a nonce (a static page) the gateway is never allowed.
    expect(contentSecurityPolicy({ dev: false, cardFields: true })).toContain("frame-src 'none'");
  });

  it('card_page_loads_no_third_party_script_but_pins: the proxy gives /pay/card/* its policy and nothing else gets it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
    const res = await proxy(request(`/pay/card/cs_${'a'.repeat(32)}`) as never);
    const csp = res.headers.get('content-security-policy') ?? '';
    const scriptSrc = /script-src ([^;]+)/.exec(csp)![1]!.split(' ');
    expect(scriptSrc.filter((s) => s.startsWith('https:'))).toEqual(['https://cdn.pinpayments.com']);
    expect(/frame-src https:\/\/cdn\.pinpayments\.com(;|$)/.test(csp)).toBe(true);
    const other = await proxy(request('/checkout/MT-ABC123') as never);
    expect(other.headers.get('content-security-policy')).toContain("frame-src 'none'");
    // The page itself loads only the gateway's script: its source names no other origin.
    const src = readFileSync(join(__dirname, '../components/pay/card-page.tsx'), 'utf8') + readFileSync(join(__dirname, 'card-page.ts'), 'utf8');
    expect(src.match(/https:\/\/[a-z0-9.-]+/g) ?? []).toEqual([]);
  });
});
