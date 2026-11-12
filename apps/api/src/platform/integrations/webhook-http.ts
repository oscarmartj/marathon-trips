import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import type { ResolvedAddress } from './ssrf';
import { hostOf } from './ssrf';

export type SendErrorCode = 'timeout' | 'connection_failed' | 'tls_error' | 'http_redirect' | 'http_error';

export interface SendResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  errorCode: SendErrorCode | null;
}

export interface SendOptions {
  timeoutMs: number;
}

const TLS_CODES = /^(CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_|SELF_SIGNED_CERT|HOSTNAME_MISMATCH|ERR_TLS)/;

/**
 * One POST to an address already checked by pickAddress (task 8.4, plan 4.4). The connection goes to that address only
 * (the lookup is pinned, so DNS cannot change between the check and the connection), with the normal TLS checks against
 * the host name. No agent, no redirects (3xx is a failure), one timer for the whole exchange, and the response body is
 * never read: the status line is all we keep. Errors become fixed codes, never the error message (it can name hosts).
 */
export function postWebhook(url: URL, pinned: ResolvedAddress, headers: Record<string, string>, body: string, opts: SendOptions): Promise<SendResult> {
  const started = Date.now();
  const host = hostOf(url);
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const cb = callback as (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
    if ((options as { all?: boolean }).all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  };
  const isHttps = url.protocol === 'https:';
  const request = isHttps ? httpsRequest : httpRequest;
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const done = (r: Omit<SendResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const req = request(
      {
        protocol: url.protocol,
        hostname: isIP(host) ? host : url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        agent: false,
        lookup,
        ...(isHttps && !isIP(host) ? { servername: host } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        req.destroy();
        if (status >= 200 && status < 300) done({ ok: true, status, errorCode: null });
        else done({ ok: false, status, errorCode: status >= 300 && status < 400 ? 'http_redirect' : 'http_error' });
      },
    );
    const timer = setTimeout(() => {
      done({ ok: false, status: null, errorCode: 'timeout' });
      req.destroy();
    }, opts.timeoutMs);
    req.on('error', (err: NodeJS.ErrnoException) => {
      done({ ok: false, status: null, errorCode: TLS_CODES.test(String(err.code ?? '')) ? 'tls_error' : 'connection_failed' });
    });
    req.end(body);
  });
}
