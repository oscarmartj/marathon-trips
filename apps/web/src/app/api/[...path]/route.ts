import { apiBase, apiUrl, forwardHeaders, responseHeaders, trustedHops } from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

const MAX_BODY = 100 * 1024;

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const url = apiUrl(apiBase(), path, new URL(req.url).search);
  if (!url) return Response.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
  let body: ArrayBuffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY) return Response.json({ code: 'payload_too_large', message: 'The request is too large' }, { status: 413 });
  }
  const res = await fetch(url, { method: req.method, headers: forwardHeaders(req.headers, trustedHops()), body, redirect: 'manual', cache: 'no-store' });
  return new Response(res.body, { status: res.status, headers: responseHeaders(res) });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
