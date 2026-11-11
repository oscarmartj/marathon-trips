import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthContext } from '../access/auth-context';

export interface ApiRequest extends Request {
  requestId: string;
  auth?: AuthContext;
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Gives every request an id (kept from X-Request-Id when it looks like one) and the API's fixed security headers. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  (req as ApiRequest).requestId = id;
  res.setHeader('X-Request-Id', id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  // API responses are personal or live: never cached by browsers or proxies.
  res.setHeader('Cache-Control', 'no-store');
  next();
}
