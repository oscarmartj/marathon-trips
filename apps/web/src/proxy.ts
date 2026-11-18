import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce, usesNonce } from '@/lib/csp';
import { findRedirect, loadRedirects } from '@/lib/redirects';
import { routeLocale } from '@/lib/locale-routing';
import { LOCALE_COOKIE, enabledLocales, localePath, splitLocale } from '@/lib/locales';

/** A page load by the browser itself, as opposed to the framework's own fetches for a client-side navigation or a prefetch. */
const isNavigation = (request: NextRequest): boolean =>
  !request.headers.has('rsc') && !request.headers.has('next-router-prefetch') && (request.headers.get('sec-fetch-dest') ?? 'document') === 'document';

const YEAR_SECONDS = 60 * 60 * 24 * 365;
const isAdmin = (pathname: string): boolean => pathname === '/admin' || pathname.startsWith('/admin/');

/**
 * Task 8.5 (S-03): the page Content-Security-Policy. A dynamic page gets a fresh nonce, passed to Next.js in the request
 * headers (it then marks its own scripts with it) and sent in the response; any other page gets the static policy.
 */
function security(request: NextRequest, pathWithoutLocale: string): { csp: string; requestHeaders?: Headers } {
  const dev = process.env.NODE_ENV !== 'production';
  if (!usesNonce(pathWithoutLocale)) return { csp: contentSecurityPolicy({ dev }) };
  const csp = contentSecurityPolicy({ nonce: newNonce(), dev });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', csp);
  return { csp, requestHeaders };
}

const withCsp = (res: NextResponse, csp: string): NextResponse => {
  res.headers.set('Content-Security-Policy', csp);
  return res;
};

/**
 * Three jobs on every page request. First, the page Content-Security-Policy (above). Second, the redirects staff manage
 * in the content manager, so a moved page keeps its visitors without a deploy (matched on the address without its
 * language prefix; the target keeps the language). Third, languages: the default language has no prefix in its
 * address, so its pages are served from `/en-AU/...` underneath, and the other enabled languages are served at their
 * own prefix (see `locale-routing.ts`). The staff panel gets only the first.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const { locale: prefixed, rest } = splitLocale(pathname);
  const { csp, requestHeaders } = security(request, isAdmin(pathname) ? pathname : rest);
  const next = () => withCsp(requestHeaders ? NextResponse.next({ request: { headers: requestHeaders } }) : NextResponse.next(), csp);
  if (isAdmin(pathname) || (request.method !== 'GET' && request.method !== 'HEAD')) return next();

  const hit = findRedirect(await loadRedirects(), rest, search);
  if (hit) {
    const internal = hit.location.startsWith('/');
    const location = internal && prefixed ? localePath(hit.location, prefixed) : hit.location;
    return NextResponse.redirect(new URL(location, request.url), hit.status);
  }
  const enabled = enabledLocales();
  const route = routeLocale(pathname, request.cookies.get(LOCALE_COOKIE)?.value, enabled);
  if (route.kind === 'pass') return next();
  let res: NextResponse;
  if (route.kind === 'redirect') {
    res = NextResponse.redirect(new URL(`${route.to}${search}`, request.url), 308);
  } else {
    const url = new URL(request.nextUrl.href);
    url.pathname = route.to;
    res = withCsp(requestHeaders ? NextResponse.rewrite(url, { request: { headers: requestHeaders } }) : NextResponse.rewrite(url), csp);
  }
  // Only a person navigating to a page chooses a language. The framework's background fetches (prefetching a link, loading a
  // route's data) must not: one still in flight after a switch would put the old language back.
  if (route.remember && isNavigation(request)) res.cookies.set(LOCALE_COOKIE, route.remember, { path: '/', maxAge: YEAR_SECONDS, sameSite: 'lax', httpOnly: true, secure: request.nextUrl.protocol === 'https:' });
  // With more than one language, the same address can differ by the remembered choice: shared caches must not mix them up.
  if (enabled.length > 1) res.headers.append('Vary', 'Cookie');
  return res;
}

export const config = {
  // Everything except the API proxy, build output, and any path with a file extension. The panel is included for its
  // Content-Security-Policy only (task 8.5).
  matcher: ['/((?!api(?:/|$)|_next(?:/|$)|.*\\.[A-Za-z0-9]{1,8}$).*)'],
};
