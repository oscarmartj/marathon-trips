/**
 * Task 8.5 (S-03): the page Content-Security-Policy, set by proxy.ts on every page so each route has one source for it.
 *
 * Pages that are rendered on every request (the staff panel and the customer pages that read the session cookie) get a
 * per-request nonce with 'strict-dynamic': only scripts Next.js itself marked with the nonce run. Static and incremental
 * pages are built once and served to everyone, so they cannot carry a per-request nonce without becoming dynamic
 * (against .claude/rules/web.md); they keep 'unsafe-inline' for scripts as the realistic minimum, and the rest of the
 * policy still blocks foreign scripts, plugins, framing, <base> hijacking and sending data to other sites.
 * Task 9.x: hosted payment fields will need their gateway in frame-src, form-action and connect-src.
 */
export function contentSecurityPolicy(opts: { nonce?: string; dev: boolean }): string {
  const script = opts.nonce ? [`'self'`, `'nonce-${opts.nonce}'`, `'strict-dynamic'`] : [`'self'`, `'unsafe-inline'`];
  // The development server evaluates code and talks to its hot-reload socket; a production build needs neither.
  if (opts.dev) script.push(`'unsafe-eval'`);
  return [
    `default-src 'self'`,
    `script-src ${script.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    // Content images are https addresses chosen by staff (task 8.1); placeholders are local or data: URIs.
    `img-src 'self' https: data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'${opts.dev ? ' ws: wss:' : ''}`,
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `manifest-src 'self'`,
    `worker-src 'self' blob:`,
  ].join('; ');
}

/** Paths (without a language prefix) rendered on every request: they get the nonce policy. */
const DYNAMIC_PAGES = [/^\/admin(\/.*)?$/, /^\/account$/, /^\/account\/bookings\/.+$/, /^\/trips\/requests\/.+$/, /^\/quotes\/.+$/, /^\/waitlist\/.+$/, /^\/checkout\/.+$/];
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
