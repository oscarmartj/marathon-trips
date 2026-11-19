// Pin Payments' webhook signature (plan docs/plans/4.4-au-card-gateway.md, section 8.1): header `Pin-Signature` with
// `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t." + raw body, keyed with the endpoint's key>`. Synchronous, no network,
// constant-time comparison, never throws. A1 (hex encoding) and A16 (a new `t` on retries) are unverified.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookVerification } from '../../core/provider';
import { EVENT_TOKEN, isObj, parsePinEvent } from './mapping';

export const PIN_SIGNATURE_HEADER = 'pin-signature';
const HEADER_MAX = 512;
const MAX_V1 = 4;
const T = /^[0-9]{1,12}$/;
const V1 = /^[0-9a-f]{64}$/;
export const STALE_AFTER_MS = 300_000;

/** The parts of a Pin-Signature header, or null if it is not exactly `t=…` once and `v1=…` one to four times. */
export function parseSignatureHeader(value: string | undefined): { t: string; v1: string[] } | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > HEADER_MAX || !/^[\x21-\x7e]+$/.test(value)) return null;
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === 't') {
      if (t !== undefined || !T.test(v)) return null;
      t = v;
    } else if (k === 'v1') {
      if (!V1.test(v)) return null;
      v1.push(v);
    } else return null;
  }
  if (t === undefined || v1.length === 0 || v1.length > MAX_V1) return null;
  return { t, v1 };
}

/** The signature Pin would send for this body at `t` (also used by the fake and the tests). */
export const pinSignature = (key: string, t: string, rawBody: Buffer): string => createHmac('sha256', key).update(`${t}.`).update(rawBody).digest('hex');

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** The event id of a body, when readable, for a rejection that names what it refused. */
function claimedEventId(rawBody: Buffer): string | undefined {
  try {
    const v: unknown = JSON.parse(rawBody.toString('utf8'));
    return isObj(v) && typeof v.token === 'string' && EVENT_TOKEN.test(v.token) ? v.token : undefined;
  } catch {
    return undefined;
  }
}

export function verifyPinWebhook(key: string, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification {
  try {
    const sig = parseSignatureHeader(header(headers, PIN_SIGNATURE_HEADER));
    if (!sig || key.length === 0) return { ok: false, code: 'bad_signature' };
    const expected = Buffer.from(pinSignature(key, sig.t, rawBody), 'hex');
    let match = false;
    for (const v of sig.v1) if (timingSafeEqual(expected, Buffer.from(v, 'hex'))) match = true;
    if (!match) return { ok: false, code: 'bad_signature' };
    // After the signature, so only genuine deliveries are told their timestamp is the problem.
    const drift = now.getTime() - Number(sig.t) * 1000;
    if (drift > STALE_AFTER_MS || drift < -STALE_AFTER_MS) return { ok: false, code: 'stale_timestamp' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, code: 'malformed' };
    }
    const event = parsePinEvent(parsed);
    if (!event) {
      const claimed = claimedEventId(rawBody);
      return { ok: false, code: 'malformed', ...(claimed ? { claimedEventId: claimed } : {}) };
    }
    return { ok: true, event };
  } catch {
    return { ok: false, code: 'bad_signature' };
  }
}
