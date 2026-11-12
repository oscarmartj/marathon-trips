import { BlockList, isIP } from 'node:net';
import { AppError } from '../errors/safe-error';

/**
 * Where outgoing webhooks may connect (task 8.4, plan 4.4 and 11.5). Only public unicast addresses: IPv4 outside the
 * special-purpose ranges, and IPv6 inside 2000::/3 minus its special ranges. Everything else, including every IPv6 form
 * that embeds an IPv4 address (mapped, SIIT, NAT64), is blocked. Loopback is reported apart so that, outside production
 * only, an origin listed in WEBHOOK_DEV_ALLOWLIST can reach a receiver on this machine.
 */
const blockedV4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(net, bits, 'ipv4');

const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');

// Inside 2000::/3 but not public: IETF protocol assignments (Teredo, ORCHID…), documentation and 6to4.
const blockedV6 = new BlockList();
for (const [net, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(net, bits, 'ipv6');
// Listed for the record and for tests; all of them already fall outside 2000::/3.
export const BLOCKED_OUTSIDE_GLOBAL_V6 = ['::/128', '::1/128', '::/96', '::ffff:0:0/96', '::ffff:0:0:0/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8'];

const loopbackV6 = new BlockList();
loopbackV6.addAddress('::1', 'ipv6');

export type AddressClass = 'public' | 'loopback' | 'blocked';

export function classifyAddress(address: string): AddressClass {
  const ip = address.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (family === 4) {
    if (blockedV4.check(ip, 'ipv4')) return ip.startsWith('127.') ? 'loopback' : 'blocked';
    return 'public';
  }
  if (family === 6) {
    if (loopbackV6.check(ip, 'ipv6')) return 'loopback';
    if (!globalUnicastV6.check(ip, 'ipv6')) return 'blocked';
    return blockedV6.check(ip, 'ipv6') ? 'blocked' : 'public';
  }
  return 'blocked';
}

export interface UrlRules {
  production: boolean;
  /** Host of WEB_ORIGIN: our own site is never a webhook target. */
  ownHost: string;
}

const invalid = (why: string) => new AppError('invalid_url', `The webhook address is not allowed (${why})`);

export const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

/**
 * Checks a webhook address when it is saved and again before each send. The WHATWG parser already turns 0x7f000001,
 * 2130706433 and 127.1 into 127.0.0.1, so IP literals are classified in their normal form. Throws `invalid_url`.
 */
export function validateWebhookUrl(raw: string, rules: UrlRules): URL {
  if (raw.length > 2048) throw invalid('too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('not a URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !rules.production)) throw invalid(rules.production ? 'https only' : 'http or https only');
  if (url.username || url.password) throw invalid('no user name or password');
  if (raw.includes('#')) throw invalid('no fragment');
  if (rules.production && url.port !== '') throw invalid('port 443 only');
  const host = hostOf(url);
  if (!host) throw invalid('no host');
  if (host === rules.ownHost.replace(/\.$/, '').toLowerCase()) throw invalid('this site');
  if (isIP(host)) {
    const cls = classifyAddress(host);
    if (cls === 'blocked' || (cls === 'loopback' && rules.production)) throw invalid('private address');
    return url;
  }
  if (rules.production && (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.'))) throw invalid('not a public name');
  return url;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

/**
 * The address to connect to: every resolved address must be public (one bad answer blocks the lot), except that a
 * loopback answer is accepted when `allowLoopback` (outside production, allow-listed origin). Throws `blocked_address`
 * or `dns_failed`.
 */
export async function pickAddress(host: string, resolve: Resolver, allowLoopback: boolean): Promise<ResolvedAddress> {
  let found: ResolvedAddress[];
  if (isIP(host)) found = [{ address: host, family: isIP(host) as 4 | 6 }];
  else {
    try {
      found = await resolve(host);
    } catch {
      throw new AppError('dns_failed', 'The webhook host could not be resolved');
    }
  }
  if (found.length === 0) throw new AppError('dns_failed', 'The webhook host could not be resolved');
  for (const a of found) {
    const cls = classifyAddress(a.address);
    if (cls === 'blocked' || (cls === 'loopback' && !allowLoopback)) throw new AppError('blocked_address', 'The webhook host resolves to an address that is not allowed');
  }
  return found[0]!;
}
