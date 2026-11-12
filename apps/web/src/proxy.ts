import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { findRedirect, loadRedirects } from '@/lib/redirects';

/** Applies the redirects staff manage in the content manager, so a moved page keeps its visitors without a deploy. */
export async function proxy(request: NextRequest) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return NextResponse.next();
  const hit = findRedirect(await loadRedirects(), request.nextUrl.pathname, request.nextUrl.search);
  if (!hit) return NextResponse.next();
  return NextResponse.redirect(new URL(hit.location, request.url), hit.status);
}

export const config = {
  // Everything except the panel, the API proxy, build output, and any path with a file extension.
  matcher: ['/((?!admin(?:/|$)|api(?:/|$)|_next(?:/|$)|.*\\.[A-Za-z0-9]{1,8}$).*)'],
};
