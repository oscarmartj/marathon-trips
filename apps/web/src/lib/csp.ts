import { CARD_PAGE_FRAME_ORIGINS, SECURE_FIELDS_PAGE_ORIGINS } from '@mt/shared';

/**
 * Task 8.5 (S-03): the page Content-Security-Policy, set by proxy.ts on every page so each route has one source for it.
 *
 * Pages that are rendered on every request (the staff panel and the customer pages that read the session cookie) get a
 * per-request nonce with 'strict-dynamic': only scripts Next.js itself marked with the nonce run. Static and incremental
 * pages are built once and served to everyone, so they cannot carry a per-request nonce without becoming dynamic
 * (against .claude/rules/web.md); they keep 'unsafe-inline' for scripts as the realistic minimum, and the rest of the
 * policy still blocks foreign scripts, plugins, framing, <base> hijacking and sending data to other sites.
 * Task 4.4: the card page of a card session (`/pay/card/…`) also allows the gateway's hosted fields: its script (the
 * page's own nonced code inserts it, which 'strict-dynamic' trusts; the host is listed for browsers without CSP3) and
 * its iframes. Only on that route; every other page keeps `frame-src 'none'`.
 * Task 9.1: eWAY's Secure Fields page (`/pay/secure-fields/…`) has its own list, eWAY's origins only, so neither card
 * page allows the other gateway (plan docs/plans/9.1-eway.md, section 10.3; the bank's own 3-D Secure frame may need
 * more: plan 20 m11, left for a reviewed change after the sandbox run).
 */
export function contentSecurityPolicy(opts: { nonce?: string; dev: boolean; cardFields?: boolean; secureFields?: boolean }): string {
  const script = opts.nonce ? [`'self'`, `'nonce-${opts.nonce}'`, `'strict-dynamic'`] : [`'self'`, `'unsafe-inline'`];
  const origins = opts.secureFields === true ? SECURE_FIELDS_PAGE_ORIGINS : CARD_PAGE_FRAME_ORIGINS;
  const card = (opts.cardFields === true || opts.secureFields === true) && !!opts.nonce;
  if (card) script.push(...origins);
  // The development server evaluates code and talks to its hot-reload socket; a production build needs neither.
  if (opts.dev) script.push(`'unsafe-eval'`);
  return [
    `default-src 'self'`,
    `script-src ${script.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    // Content images are https addresses chosen by staff (task 8.1); placeholders are local or data: URIs.
    `img-src 'self' https: data: blob:`,
    `font-src 'self'`,
    // Task 9.1 (plan 9.1, section 10.3): eWAY's page may call eWAY's origins from its own scripts; no other page does.
    `connect-src 'self'${opts.secureFields === true && card ? ` ${origins.join(' ')}` : ''}${opts.dev ? ' ws: wss:' : ''}`,
    card ? `frame-src ${origins.join(' ')}` : `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `manifest-src 'self'`,
    `worker-src 'self' blob:`,
  ].join('; ');
}

/** Paths (without a language prefix) rendered on every request: they get the nonce policy. */
const DYNAMIC_PAGES = [/^\/admin(\/.*)?$/, /^\/account$/, /^\/account\/bookings\/.+$/, /^\/trips\/requests\/.+$/, /^\/quotes\/.+$/, /^\/waitlist\/.+$/, /^\/checkout\/.+$/, /^\/pay\/card\/[^/]+$/, /^\/pay\/secure-fields\/[^/]+$/];
/** Task 4.4: the card page, whose policy also allows the gateway's hosted fields. */
const CARD_PAGE = /^\/pay\/card\/[^/]+$/;

export function usesCardFields(pathWithoutLocale: string): boolean {
  const p = pathWithoutLocale.length > 1 ? pathWithoutLocale.replace(/\/$/, '') : pathWithoutLocale;
  return CARD_PAGE.test(p);
}

/** Task 9.1: eWAY's Secure Fields page, whose policy allows eWAY's origins only. */
const SECURE_FIELDS_PAGE = /^\/pay\/secure-fields\/[^/]+$/;

export function usesSecureFields(pathWithoutLocale: string): boolean {
  const p = pathWithoutLocale.length > 1 ? pathWithoutLocale.replace(/\/$/, '') : pathWithoutLocale;
  return SECURE_FIELDS_PAGE.test(p);
}
/** Panel pages that are built once (no session yet): the static policy. */
const STATIC_ADMIN = /^\/admin\/(sign-in|enrol)\/?$/;

export function usesNonce(pathWithoutLocale: string): boolean {
  const p = pathWithoutLocale.length > 1 ? pathWithoutLocale.replace(/\/$/, '') : pathWithoutLocale;
  if (STATIC_ADMIN.test(p)) return false;
  return DYNAMIC_PAGES.some((r) => r.test(p));
}

/** 16 random bytes, base64: a fresh nonce for one response. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
