import { parse, serialize } from 'cookie';
import type { Request, Response } from 'express';
import type { UserKind } from '../access/auth-context';

export type CookieKind = UserKind | 'staff_mfa';

/**
 * One cookie per user kind, so a customer session can never be presented as a staff one (plan 4.2). With Secure the
 * __Host- prefix pins it to this host, path / and no Domain. Staff cookies are SameSite=Strict; the customer cookie is
 * Lax so links from emails land signed in.
 */
export function cookieName(kind: CookieKind, secure: boolean): string {
  const base = kind === 'staff' ? 'mt_staff_session' : kind === 'customer' ? 'mt_customer_session' : 'mt_staff_mfa';
  return secure ? `__Host-${base}` : base;
}

export function readCookie(req: Request, kind: CookieKind, secure: boolean): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  return parse(header)[cookieName(kind, secure)];
}

export function setCookie(res: Response, kind: CookieKind, secure: boolean, value: string, maxAgeSeconds: number): void {
  res.append('Set-Cookie', serialize(cookieName(kind, secure), value, {
    httpOnly: true, secure, path: '/', sameSite: kind === 'customer' ? 'lax' : 'strict', maxAge: maxAgeSeconds,
  }));
}

export function clearCookie(res: Response, kind: CookieKind, secure: boolean): void {
  res.append('Set-Cookie', serialize(cookieName(kind, secure), '', {
    httpOnly: true, secure, path: '/', sameSite: kind === 'customer' ? 'lax' : 'strict', maxAge: 0,
  }));
}
