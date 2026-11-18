import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { BlockList, isIPv4 } from 'node:net';

/** Set by the web app's /api proxy on every request it forwards (task 8.5); a browser cannot send it (allow list). */
export const PROXIED_HEADER = 'x-mt-proxied';

const PRIVATE = new BlockList();
for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['::', 128]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

/** True for loopback, private, link-local and unspecified addresses, IPv4-mapped IPv6 included. */
export function isPrivateAddress(ip: string | undefined): boolean {
  if (!ip) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped ? mapped[1]! : ip;
  try {
    return isIPv4(v4) ? PRIVATE.check(v4, 'ipv4') : PRIVATE.check(ip, 'ipv6');
  } catch {
    return true;
  }
}

const WARN_EVERY_MS = 10 * 60_000;

/**
 * Task 8.5 (S-04). Browser requests reach the API only through the web app's proxy. If the address the API works out for
 * them (Express `req.ip`, from TRUST_PROXY and X-Forwarded-For) is a private one, the chain Caddy → web → API is losing
 * the real client address (for example Docker's userland proxy showing its gateway as every client), and every visitor
 * then shares one rate-limit bucket. This counts such requests (no address is stored), warns in the log at most every ten
 * minutes in production, and the system monitor reports `client_ip_private`.
 */
export class ClientIpWatch {
  proxied = 0;
  privateAddress = 0;
  lastPrivateAt: Date | null = null;
  private lastWarnAt = 0;
  private readonly logger = new Logger('ClientIp');

  record(proxied: boolean, ip: string | undefined, warn: boolean, now: Date = new Date()): void {
    if (!proxied) return; // the web app's own server-side calls carry no client address, by design
    this.proxied++;
    if (!isPrivateAddress(ip)) return;
    this.privateAddress++;
    this.lastPrivateAt = now;
    if (warn && now.getTime() - this.lastWarnAt >= WARN_EVERY_MS) {
      this.lastWarnAt = now.getTime();
      this.logger.warn('client_ip_private: browser requests arrive with a private client address; check TRUST_PROXY, WEB_TRUSTED_PROXY_HOPS and the Docker proxy (docs/deploy/guide.md)');
    }
  }

  reset(): void {
    this.proxied = 0;
    this.privateAddress = 0;
    this.lastPrivateAt = null;
    this.lastWarnAt = 0;
  }
}

export const clientIpWatch = new ClientIpWatch();

export function clientIpMiddleware(warn: boolean) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    clientIpWatch.record(req.header(PROXIED_HEADER) === '1', req.ip, warn);
    next();
  };
}
