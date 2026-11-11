import { isIPv4, isIPv6 } from 'node:net';
import type { Request } from 'express';

export interface RequestMeta {
  userAgent: string | null;
  ipPrefix: string | null;
}

/** IP truncated to /24 (IPv4) or /48 (IPv6) before it is stored (plan 5.1). */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIPv6(ip)) {
    const [head] = ip.split('::');
    const groups = (head ?? '').split(':').filter(Boolean);
    while (groups.length < 3) groups.push('0');
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

export const requestMeta = (req: Request): RequestMeta => ({
  userAgent: (req.header('user-agent') ?? '').slice(0, 256) || null,
  ipPrefix: ipPrefix(req.ip),
});
