import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { findRedirect, loadRedirects } from '@/lib/redirects';
import { routeLocale } from '@/lib/locale-routing';
import { LOCALE_COOKIE, enabledLocales, localePath, splitLocale } from '@/lib/locales';

/** A page load by the browser itself, as opposed to the framework's own fetches for a client-side navigation or a prefetch. */
const isNavigation = (request: NextRequest): boolean =>
  !request.headers.has('rsc') && !request.headers.has('next-router-prefetch') && (request.headers.get('sec-fetch-dest') ?? 'document') === 'document';

const YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Two jobs on every page request. First, the redirects staff manage in the content manager, so a moved page keeps its visitors
 * without a deploy (matched on the address without its language prefix; the target keeps the language). Second, languages:
 * the default language has no prefix in its address, so its pages are served from `/en-AU/...` underneath, and the other
 * enabled languages are served at their own prefix (see `locale-routing.ts`).
 */
export async function proxy(request: NextRequest) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const { locale: prefixed, rest } = splitLocale(pathname);
  const hit = findRedirect(await loadRedirects(), rest, search);
  if (hit) {
    const internal = hit.location.startsWith('/');
    const location = internal && prefixed ? localePath(hit.location, prefixed) : hit.location;
    return NextResponse.redirect(new URL(location, request.url), hit.status);
  }
  const enabled = enabledLocales();
  const route = routeLocale(pathname, request.cookies.get(LOCALE_COOKIE)?.value, enabled);
  if (route.kind === 'pass') return NextResponse.next();
  let res: NextResponse;
  if (route.kind === 'redirect') {
    res = NextResponse.redirect(new URL(`${route.to}${search}`, request.url), 308);
  } else {
    const url = new URL(request.nextUrl.href);
    url.pathname = route.to;
    res = NextResponse.rewrite(url);
  }
  // Only a person navigating to a page chooses a language. The framework's background fetches (prefetching a link, loading a
  // route's data) must not: one still in flight after a switch would put the old language back.
  if (route.remember && isNavigation(request)) res.cookies.set(LOCALE_COOKIE, route.remember, { path: '/', maxAge: YEAR_SECONDS, sameSite: 'lax', httpOnly: true, secure: request.nextUrl.protocol === 'https:' });
  // With more than one language, the same address can differ by the remembered choice: shared caches must not mix them up.
  if (enabled.length > 1) res.headers.append('Vary', 'Cookie');
  return res;
}

export const config = {
  // Everything except the panel, the API proxy, build output, and any path with a file extension.
  matcher: ['/((?!admin(?:/|$)|api(?:/|$)|_next(?:/|$)|.*\\.[A-Za-z0-9]{1,8}$).*)'],
};
