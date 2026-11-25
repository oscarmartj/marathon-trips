// HTTP for the Airwallex adapter (plan docs/plans/9.2-airwallex.md, section 11): a fixed host per mode, a login per
// adapter call (no token cache), the pinned API version on every request, exact JSON both ways, and errors as codes.
import { ProviderError } from '../../core/provider';
import type { PaymentModeName, ProviderContext } from '../../core/provider';
import { writeExact } from './json';
import type { JsonOut } from './json';
import { errorCode, isObj, parseExact } from './mapping';
import type { Obj } from './mapping';

/** Fixed in code by mode: no option or variable changes them. Live is unreachable while the adapter is experimental. */
export const AIRWALLEX_API_BASE: Record<PaymentModeName, string> = { test: 'https://api.sandbox.airwallex.com', live: 'https://api.airwallex.com' };
/** A1: Checkout Sessions need 2026-05-29 or later; the webhook subscription must use the same version. */
export const AIRWALLEX_API_VERSION = '2026-05-29';
const FETCH_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;

/** A15: no test or live marker is documented; these are shape checks only (the host protects test money). */
export const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const API_KEY = /^[A-Za-z0-9_-]{32,256}$/;

export interface AirwallexRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface AirwallexResponse {
  status: number;
  body: string;
}
/** One HTTP exchange with Airwallex. Tests inject the fake; the API always uses fetch to the host of the context's mode. */
export type AirwallexTransport = (req: AirwallexRequest) => Promise<AirwallexResponse>;

export const fetchTransport: AirwallexTransport = async (req) => {
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  } catch (err) {
    throw new ProviderError((err as { name?: string })?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable', true);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > RESPONSE_MAX_BYTES) throw new ProviderError('provider_unavailable', true);
  return { status: res.status, body: buf.toString('utf8') };
};

/** An answer: 2xx with an object body, or an error with Airwallex's code (A14). */
export type Answer = { ok: true; status: number; body: Obj } | { ok: false; status: number; code: string | undefined };

/** One adapter call's authenticated session with Airwallex. The token lives only in this object, for this call. */
export class AirwallexApi {
  private constructor(
    private readonly transport: AirwallexTransport,
    private readonly base: string,
    private readonly token: string,
  ) {}

  /** Logs in (POST /api/v1/authentication/login). Bad credentials: provider_auth_failed, before or after the network. */
  static async open(transport: AirwallexTransport, ctx: ProviderContext): Promise<AirwallexApi> {
    const clientId = ctx.credentials.clientId ?? '';
    const apiKey = ctx.credentials.apiKey ?? '';
    if (!CLIENT_ID.test(clientId) || !API_KEY.test(apiKey)) throw new ProviderError('provider_auth_failed', false);
    const base = AIRWALLEX_API_BASE[ctx.mode];
    const a = await exchange(transport, { method: 'POST', url: `${base}/api/v1/authentication/login`, headers: { 'x-client-id': clientId, 'x-api-key': apiKey, 'x-api-version': AIRWALLEX_API_VERSION, 'content-type': 'application/json' }, body: '{}' });
    if (!a.ok) throw errorFor(a);
    const token = a.body.token;
    if (typeof token !== 'string' || token.length < 8 || token.length > 8192) throw new ProviderError('provider_unavailable', true);
    return new AirwallexApi(transport, base, token);
  }

  request(method: 'GET' | 'POST', path: string, opts: { query?: ReadonlyArray<[string, string]>; body?: JsonOut } = {}): Promise<Answer> {
    const qs = opts.query?.length ? `?${new URLSearchParams(opts.query as Array<[string, string]>).toString()}` : '';
    return exchange(this.transport, {
      method, url: `${this.base}${path}${qs}`,
      headers: { authorization: `Bearer ${this.token}`, 'x-api-version': AIRWALLEX_API_VERSION, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(opts.body !== undefined ? { body: writeExact(opts.body) } : {}),
    });
  }

  /** A request that must succeed: any error becomes its ProviderError. */
  async must(method: 'GET' | 'POST', path: string, opts: { query?: ReadonlyArray<[string, string]>; body?: JsonOut } = {}): Promise<Obj> {
    const a = await this.request(method, path, opts);
    if (!a.ok) throw errorFor(a);
    return a.body;
  }
}

async function exchange(transport: AirwallexTransport, req: AirwallexRequest): Promise<Answer> {
  let res: AirwallexResponse;
  try {
    res = await transport(req);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('provider_unavailable', true);
  }
  let body: unknown;
  try {
    body = res.body === '' ? {} : parseExact(res.body);
  } catch {
    body = undefined;
  }
  if (res.status >= 200 && res.status < 300) {
    if (!isObj(body)) throw new ProviderError('provider_unavailable', true);
    return { ok: true, status: res.status, body };
  }
  return { ok: false, status: res.status, code: errorCode(body) };
}

/**
 * The ProviderError of an error answer (plan 11). Only 401/403 and a 400 `validation_error` are definitive; a 404 is
 * provider_not_found (callers that read turn it into null); everything else may still be in flight: retryable.
 */
export function errorFor(a: { status: number; code: string | undefined }): ProviderError {
  if (a.status === 401 || a.status === 403) return new ProviderError('provider_auth_failed', false);
  if (a.status === 404) return new ProviderError('provider_not_found', false);
  if (a.status === 429) return new ProviderError('provider_busy', true);
  if (a.status === 400 && a.code === 'validation_error') return new ProviderError('provider_rejected', false);
  if (a.status === 400 && a.code === 'duplicate_request_id') return new ProviderError('provider_busy', true);
  return new ProviderError('provider_unavailable', true);
}
