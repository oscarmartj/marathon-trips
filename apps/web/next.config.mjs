// Task 8.5 (S-03): security headers. Next.js matches each rule against the original address and, for the same header,
// the last matching rule wins, so the rules for every page come first and the stricter ones for token pages after them.
// The Content-Security-Policy is not here: proxy.ts sets it on every page (a nonce on the dynamic ones), so each route
// has exactly one source for it. Nothing here applies to /api/*: the proxy forwards the API's own, stricter headers.

/** A language prefix, as `splitLocale` in src/lib/locales.ts reads it (`/es-ES/pay`). */
const LOCALE = ':locale([A-Za-z]{2,3}-[A-Za-z0-9]{2,8})';
const withLocale = (path) => [path, `/${LOCALE}${path}`];

export const PAGE_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // No page is meant to be framed; CSP frame-ancestors says the same to newer browsers.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Task 9.x: hosted payment fields may need payment=(self "<gateway>") here.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** Pages that read a one-time token or a signed reference from the address: they never send a Referer (plan 4.1). */
export const TOKEN_PAGES = ['/account/sign-in/verify', '/pay', '/pay/return', '/unsubscribe', '/alerts/confirm', '/alerts/unsubscribe'];

export function headerRules() {
  const noReferrer = [{ key: 'Referrer-Policy', value: 'no-referrer' }];
  return [
    // Every address except the API proxy, the root included.
    { source: '/:path((?!api(?:/|$)).*)', headers: PAGE_HEADERS },
    ...TOKEN_PAGES.flatMap(withLocale).map((source) => ({ source, headers: noReferrer })),
    { source: '/admin/enrol', headers: noReferrer },
  ];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Task 8.3: the 404 for an address that matches no page keeps the site's language, menu and footer (src/app/global-not-found.tsx).
  experimental: { globalNotFound: true },
  async headers() {
    return headerRules();
  },
};
export default nextConfig;
