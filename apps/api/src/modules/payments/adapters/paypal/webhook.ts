// PayPal webhook signatures (plan docs/plans/4.3-paypal-adapter.md, sections 7.2 and 7.3): PayPal's documented
// self-verification (developer.paypal.com/api/rest/webhooks/rest), SHA256withRSA over
// `transmissionId|transmissionTime|webhookId|crc32(body)`, with the certificate named by `paypal-cert-url`.
// Verification is synchronous and network-free: the certificate is fetched beforehand by `prepare`, only from PayPal's
// fixed hosts, checked against a trusted root and cached. Never PayPal's words, never a log.
import { X509Certificate, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import type { PaymentModeName } from '../../core/provider';

export const PAYPAL_HEADERS = {
  transmissionId: 'paypal-transmission-id',
  transmissionTime: 'paypal-transmission-time',
  transmissionSig: 'paypal-transmission-sig',
  certUrl: 'paypal-cert-url',
  authAlgo: 'paypal-auth-algo',
} as const;
export const PAYPAL_TOLERANCE_SECONDS = 300;
export const PAYPAL_AUTH_ALGO = 'SHA256withRSA';

/** Exact certificate URLs per mode (plan 7.2, step 3; assumption A4): fixed hosts, a fixed path shape, nothing else. */
const CERT_URL: Record<PaymentModeName, RegExp> = {
  test: /^https:\/\/api(?:-m)?\.sandbox\.paypal\.com\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,100}$/,
  live: /^https:\/\/api(?:-m)?\.paypal\.com\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,100}$/,
};
/** The name the signing certificate must carry, per mode (assumption A4). */
export const PAYPAL_LEAF_NAMES: Record<PaymentModeName, string> = {
  test: 'messageverificationcerts.sandbox.paypal.com',
  live: 'messageverificationcerts.paypal.com',
};

const HEADER_MAX: Record<string, number> = {
  [PAYPAL_HEADERS.transmissionId]: 100,
  [PAYPAL_HEADERS.transmissionTime]: 40,
  [PAYPAL_HEADERS.transmissionSig]: 1024,
  [PAYPAL_HEADERS.certUrl]: 300,
  [PAYPAL_HEADERS.authAlgo]: 40,
};
const PRINTABLE = /^[\x21-\x7e]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;

export const certUrlAllowed = (url: unknown, mode: PaymentModeName): url is string => typeof url === 'string' && url.length <= 300 && CERT_URL[mode].test(url);

// ---- CRC-32 (ISO-HDLC, the zlib one), as an unsigned decimal ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The exact bytes PayPal signs. */
export const signedMessage = (transmissionId: string, transmissionTime: string, webhookId: string, rawBody: Uint8Array): Buffer =>
  Buffer.from(`${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`, 'utf8');

// ---- A minimal DER reader: enough to find the key usage extension (Node does not expose it) ----

interface Tlv { tag: number; start: number; end: number }

function readTlv(buf: Buffer, pos: number, limit: number): Tlv | null {
  if (pos + 2 > limit) return null;
  const tag = buf[pos]!;
  let len = buf[pos + 1]!;
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > limit) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i]!;
    p += n;
  }
  if (p + len > limit) return null;
  return { tag, start: p, end: p + len };
}

function children(buf: Buffer, parent: Tlv): Tlv[] | null {
  const out: Tlv[] = [];
  let p = parent.start;
  while (p < parent.end) {
    const t = readTlv(buf, p, parent.end);
    if (!t) return null;
    out.push(t);
    p = t.end;
  }
  return out;
}

const KEY_USAGE_OID = Buffer.from([0x55, 0x1d, 0x0f]);

/** The key usage bits of a certificate (bit 0 digitalSignature … bit 5 keyCertSign), `undefined` if absent, null if unreadable. */
export function keyUsageBits(der: Buffer): number | undefined | null {
  const cert = readTlv(der, 0, der.length);
  const top = cert && children(der, cert);
  const tbs = top?.[0] && children(der, top[0]);
  if (!tbs) return null;
  const extWrap = tbs.find((t) => t.tag === 0xa3);
  if (!extWrap) return undefined;
  const seq = children(der, extWrap)?.[0];
  const exts = seq && children(der, seq);
  if (!exts) return null;
  for (const ext of exts) {
    const parts = children(der, ext);
    if (!parts || parts.length < 2 || parts[0]!.tag !== 0x06) return null;
    if (!der.subarray(parts[0]!.start, parts[0]!.end).equals(KEY_USAGE_OID)) continue;
    const octets = parts[parts.length - 1]!;
    if (octets.tag !== 0x04) return null;
    const bits = readTlv(der, octets.start, octets.end);
    if (!bits || bits.tag !== 0x03 || bits.end - bits.start < 2) return null;
    const first = der[bits.start + 1]!;
    const second = bits.end - bits.start > 2 ? der[bits.start + 2]! : 0;
    // Bit n of the BIT STRING is bit (7 - n) of its first byte, then the next byte.
    let value = 0;
    for (let n = 0; n < 9; n++) {
      const byte = n < 8 ? first : second;
      if (byte & (0x80 >> (n % 8))) value |= 1 << n;
    }
    return value;
  }
  return undefined;
}
const DIGITAL_SIGNATURE = 1 << 0;
const KEY_CERT_SIGN = 1 << 5;

// ---- Certificates ----

export interface CertificateTrust {
  /** PEM roots a chain must end at. Default: Node's bundled store (tls.rootCertificates). */
  roots: readonly string[];
  /** Downloads a certificate URL already checked against the allowlist. Default: fetch, no redirects, 5 s, 64 KiB. */
  fetch: (url: string) => Promise<string>;
  leafNames: Record<PaymentModeName, string>;
}

export const CERT_MAX_BYTES = 64 * 1024;
const CERT_FETCH_TIMEOUT_MS = 5_000;

export const defaultCertificateFetch = async (url: string): Promise<string> => {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS), headers: { accept: 'application/x-pem-file, text/plain' } });
  if (res.status !== 200) throw new Error('certificate not available');
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > CERT_MAX_BYTES) throw new Error('certificate too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > CERT_MAX_BYTES) throw new Error('certificate too large');
  return buf.toString('utf8');
};

const PEM = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;
const MAX_CHAIN = 5;

const validAt = (c: X509Certificate, at: number): boolean => Date.parse(c.validFrom) <= at && at <= Date.parse(c.validTo);

/**
 * The signing key of a PEM chain, if the chain holds: the leaf names the mode's host and may sign, each certificate is
 * issued and signed by the next, every issuer is a CA allowed to sign certificates, the last is signed by a trusted
 * root, and all are valid at `at`. Null otherwise.
 */
export function signingKeyOf(pem: string, roots: readonly X509Certificate[], leafName: string, at: number): { key: KeyObject; notBefore: number; notAfter: number } | null {
  if (pem.length > CERT_MAX_BYTES) return null;
  const blocks = pem.match(PEM) ?? [];
  if (blocks.length === 0 || blocks.length > MAX_CHAIN) return null;
  let chain: X509Certificate[];
  try {
    chain = blocks.map((b) => new X509Certificate(b));
  } catch {
    return null;
  }
  const leaf = chain[0]!;
  if (leaf.checkHost(leafName, { subject: 'default', wildcards: false, partialWildcards: false }) !== leafName) return null;
  const leafUsage = keyUsageBits(leaf.raw);
  if (leafUsage === null || (leafUsage !== undefined && !(leafUsage & DIGITAL_SIGNATURE))) return null;
  if (!chain.every((c) => validAt(c, at))) return null;
  for (let i = 0; i + 1 < chain.length; i++) {
    const child = chain[i]!;
    const issuer = chain[i + 1]!;
    const usage = keyUsageBits(issuer.raw);
    if (!issuer.ca || usage === null || usage === undefined || !(usage & KEY_CERT_SIGN)) return null;
    if (!child.checkIssued(issuer) || !child.verify(issuer.publicKey)) return null;
  }
  const last = chain[chain.length - 1]!;
  const anchored = roots.some((r) => r.fingerprint256 === last.fingerprint256 || (last.checkIssued(r) && last.verify(r.publicKey)));
  if (!anchored) return null;
  const key = leaf.publicKey;
  if (key.asymmetricKeyType !== 'rsa') return null;
  return { key, notBefore: Date.parse(leaf.validFrom), notAfter: Math.min(...chain.map((c) => Date.parse(c.validTo))) };
}

const CACHE_MAX = 16;
const NEGATIVE_TTL_MS = 60_000;
const MAX_CONCURRENT_DOWNLOADS = 2;
/** New downloads allowed per minute in all (review L4): forged certificate URLs cannot keep the downloads busy. */
const MAX_DOWNLOADS_PER_MINUTE = 10;

/** Signing certificates by URL (plan 7.3): bounded, least recently used out, failures remembered for 60 s, one download per URL. */
export class CertificateStore {
  private readonly ok = new Map<string, { key: KeyObject; notBefore: number; notAfter: number }>();
  private readonly failed = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private active = 0;
  private recent: number[] = [];
  private parsedRoots?: X509Certificate[];

  constructor(private readonly trust: CertificateTrust, private readonly now: () => Date) {}

  /** Counters for tests. */
  readonly stats = { downloads: 0 };

  private roots(): X509Certificate[] {
    if (!this.parsedRoots) {
      const list: X509Certificate[] = [];
      for (const pem of this.trust.roots) {
        try {
          list.push(new X509Certificate(pem));
        } catch {
          // An unreadable root is simply not trusted.
        }
      }
      this.parsedRoots = list;
    }
    return this.parsedRoots;
  }

  /** The cached key for a URL valid at `at`, or null. Never touches the network. */
  key(url: string, at: Date): KeyObject | null {
    const hit = this.ok.get(url);
    if (!hit) return null;
    const t = at.getTime();
    if (t > hit.notAfter) {
      this.ok.delete(url);
      return null;
    }
    if (t < hit.notBefore) return null;
    this.ok.delete(url);
    this.ok.set(url, hit);
    return hit.key;
  }

  /** Fetches and caches the certificate of an allowlisted URL. Never throws. */
  async prepare(url: unknown, mode: PaymentModeName): Promise<void> {
    if (!certUrlAllowed(url, mode)) return;
    const now = this.now().getTime();
    const cached = this.ok.get(url);
    if (cached && now <= cached.notAfter) return;
    const failedAt = this.failed.get(url);
    if (failedAt !== undefined && now - failedAt < NEGATIVE_TTL_MS) return;
    const running = this.inflight.get(url);
    if (running) return running;
    if (this.active >= MAX_CONCURRENT_DOWNLOADS) return;
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= MAX_DOWNLOADS_PER_MINUTE) return;
    this.recent.push(now);
    const job = this.download(url, mode).finally(() => {
      this.inflight.delete(url);
      this.active--;
    });
    this.active++;
    this.inflight.set(url, job);
    return job;
  }

  private async download(url: string, mode: PaymentModeName): Promise<void> {
    this.stats.downloads++;
    try {
      const pem = await this.trust.fetch(url);
      const got = typeof pem === 'string' ? signingKeyOf(pem, this.roots(), this.trust.leafNames[mode], this.now().getTime()) : null;
      if (!got) throw new Error('certificate refused');
      this.failed.delete(url);
      this.ok.delete(url);
      this.ok.set(url, got);
      while (this.ok.size > CACHE_MAX) this.ok.delete(this.ok.keys().next().value as string);
    } catch {
      this.failed.set(url, this.now().getTime());
      while (this.failed.size > CACHE_MAX * 4) this.failed.delete(this.failed.keys().next().value as string);
    }
  }
}

export const defaultTrust = (): CertificateTrust => ({ roots: rootCertificates, fetch: defaultCertificateFetch, leafNames: PAYPAL_LEAF_NAMES });

// ---- Verification ----

/**
 * The cheap checks of a delivery, before any certificate is downloaded for it (review L4): every header present and
 * well-formed, the algorithm, the certificate URL of this mode, and a transmission time within the window.
 */
export function worthPreparing(mode: PaymentModeName, headers: Readonly<Record<string, string>>, now: Date): boolean {
  for (const name of Object.values(PAYPAL_HEADERS)) {
    const v = headers[name];
    if (typeof v !== 'string' || v.length === 0 || v.length > HEADER_MAX[name]! || !PRINTABLE.test(v)) return false;
  }
  if (headers[PAYPAL_HEADERS.authAlgo] !== PAYPAL_AUTH_ALGO || !BASE64.test(headers[PAYPAL_HEADERS.transmissionSig]!)) return false;
  if (!certUrlAllowed(headers[PAYPAL_HEADERS.certUrl], mode)) return false;
  const time = headers[PAYPAL_HEADERS.transmissionTime]!;
  const sentAt = TIME.test(time) ? Date.parse(time) : NaN;
  return !Number.isNaN(sentAt) && Math.abs(now.getTime() - sentAt) <= PAYPAL_TOLERANCE_SECONDS * 1000;
}

export type SignatureCheck = { ok: true } | { ok: false; code: 'bad_signature' | 'stale_timestamp' };

/** The signature and the timestamp of one delivery, with the cached certificate only (plan 7.2, steps 1 to 6). */
export function verifyPayPalSignature(
  store: CertificateStore, mode: PaymentModeName, webhookId: string, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date,
): SignatureCheck {
  const h: Record<string, string> = {};
  for (const name of Object.values(PAYPAL_HEADERS)) {
    const v = headers[name];
    if (typeof v !== 'string' || v.length === 0 || v.length > HEADER_MAX[name]! || !PRINTABLE.test(v)) return { ok: false, code: 'bad_signature' };
    h[name] = v;
  }
  if (h[PAYPAL_HEADERS.authAlgo] !== PAYPAL_AUTH_ALGO) return { ok: false, code: 'bad_signature' };
  const url = h[PAYPAL_HEADERS.certUrl]!;
  if (!certUrlAllowed(url, mode)) return { ok: false, code: 'bad_signature' };
  const time = h[PAYPAL_HEADERS.transmissionTime]!;
  const tm = TIME.exec(time);
  const sentAt = tm ? Date.parse(time) : NaN;
  if (Number.isNaN(sentAt)) return { ok: false, code: 'bad_signature' };
  const sig = h[PAYPAL_HEADERS.transmissionSig]!;
  if (!BASE64.test(sig)) return { ok: false, code: 'bad_signature' };
  const key = store.key(url, now);
  if (!key) return { ok: false, code: 'bad_signature' };
  let good = false;
  try {
    good = verifySignature('sha256', signedMessage(h[PAYPAL_HEADERS.transmissionId]!, time, webhookId, rawBody), key, Buffer.from(sig, 'base64'));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, code: 'bad_signature' };
  if (Math.abs(now.getTime() - sentAt) > PAYPAL_TOLERANCE_SECONDS * 1000) return { ok: false, code: 'stale_timestamp' };
  return { ok: true };
}
