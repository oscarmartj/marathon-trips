// Test certificates for the fake PayPal (plan docs/plans/4.3-paypal-adapter.md, section 10): a tiny DER writer builds a
// root, an intermediate and a signing leaf at test time, so no key or certificate is ever committed.
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);
const int = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const nul = () => Buffer.from([0x05, 0x00]);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const chunk: number[] = [];
    let v = n;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

const time = (d: Date): Buffer => {
  const s = d.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return tlv(0x17, Buffer.from(`${s}Z`, 'ascii'));
};
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), nul());

/** Key usage as a DER BIT STRING: 0 digitalSignature, 5 keyCertSign, 6 cRLSign. */
function keyUsage(usages: number[]): Buffer {
  let byte = 0;
  for (const u of usages) byte |= 0x80 >> u;
  let unused = 0;
  while (unused < 7 && !(byte & (1 << unused))) unused++;
  return bits(Buffer.from([byte]), unused);
}

export interface CertSpec {
  cn: string;
  /** Subject alternative DNS name. */
  dns?: string;
  ca: boolean;
  /** Key usage bits; undefined: no extension. */
  usage?: number[];
  notBefore: Date;
  notAfter: Date;
}

export interface Issued {
  pem: string;
  cert: X509Certificate;
  key: KeyObject;
  publicKey: KeyObject;
  cn: string;
}

/** A certificate for `spec`, signed by `issuer` (self-signed when absent). */
export function issue(spec: CertSpec, issuer?: Issued): Issued {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exts: Buffer[] = [seq(oid('2.5.29.19'), bool(true), octets(spec.ca ? seq(bool(true)) : seq()))];
  if (spec.usage) exts.push(seq(oid('2.5.29.15'), bool(true), octets(keyUsage(spec.usage))));
  if (spec.dns) exts.push(seq(oid('2.5.29.17'), octets(seq(tlv(0x82, Buffer.from(spec.dns, 'ascii'))))));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(randomBytes(8).fill(0x11, 0, 1)),
    SHA256_RSA,
    name(issuer?.cn ?? spec.cn),
    seq(time(spec.notBefore), time(spec.notAfter)),
    name(spec.cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...exts)),
  );
  const signature = sign('sha256', tbs, issuer?.key ?? privateKey);
  const der = seq(tbs, SHA256_RSA, bits(signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----`;
  return { pem, cert: new X509Certificate(pem), key: privateKey, publicKey, cn: spec.cn };
}

const DAY = 86_400_000;
export const SANDBOX_LEAF = 'messageverificationcerts.sandbox.paypal.com';

/** A root, an intermediate and a sandbox signing leaf, valid from a day ago for a year. */
export function paypalTestChain(opts: { leafName?: string; now?: Date } = {}): { root: Issued; intermediate: Issued; leaf: Issued; chainPem: string } {
  const now = opts.now ?? new Date();
  const window = { notBefore: new Date(now.getTime() - DAY), notAfter: new Date(now.getTime() + 365 * DAY) };
  const root = issue({ cn: 'Fake PayPal Test Root', ca: true, usage: [5, 6], ...window });
  const intermediate = issue({ cn: 'Fake PayPal Test Intermediate', ca: true, usage: [5, 6], ...window }, root);
  const leafName = opts.leafName ?? SANDBOX_LEAF;
  const leaf = issue({ cn: leafName, dns: leafName, ca: false, usage: [0], ...window }, intermediate);
  return { root, intermediate, leaf, chainPem: `${leaf.pem}\n${intermediate.pem}\n` };
}
