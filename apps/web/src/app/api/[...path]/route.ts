import { BodyTooLarge, apiBase, apiUrl, forwardHeaders, proxyError, readCappedBody, responseHeaders, trustedHops } from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const url = apiUrl(apiBase(), path, new URL(req.url).search);
  if (!url) return proxyError(404, 'not_found', 'Not found');
  let body: ArrayBuffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readCappedBody(req);
    } catch (err) {
      if (err instanceof BodyTooLarge) return proxyError(413, 'payload_too_large', 'The request is too large');
      return proxyError(400, 'bad_request', 'The request could not be read');
    }
  }
  let res: Response;
  try {
    res = await fetch(url, { method: req.method, headers: forwardHeaders(req.headers, trustedHops()), body, redirect: 'manual', cache: 'no-store' });
  } catch {
    // Task 8.5 (S-09): an unreachable API is a fixed 502, not an unhandled error page.
    return proxyError(502, 'api_unavailable', 'The service is not available right now. Try again soon.');
  }
  return new Response(res.body, { status: res.status, headers: responseHeaders(res) });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
