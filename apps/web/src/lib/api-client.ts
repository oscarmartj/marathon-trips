'use client';

/** Browser calls to the API through the same-origin proxy, with the CSRF header the API requires (plan 4.1). */
export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T & { code?: string; message?: string };
}

export async function api<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-MT-CSRF': '1', ...(init.headers ?? {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body: body as ApiResult<T>['body'] };
}

/** Reads the one-time token from the URL fragment (never sent to any server) and removes it from the address bar. */
export function takeFragmentToken(): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  if (m) window.history.replaceState(null, '', window.location.pathname);
  return m ? m[1]! : null;
}
