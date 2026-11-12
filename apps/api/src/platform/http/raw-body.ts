import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { WindowLimiter } from '../auth/attempt-limiter';

interface RawRoute {
  prefix: string;
  maxBytes: number;
  perIp: WindowLimiter;
}

/**
 * Routes that need the exact bytes of the body (incoming gateway webhooks, task 3.1, plan section 6). The middleware is
 * mounted by configureApp before Nest's body parsers and before any guard, so for these paths it alone decides, BEFORE
 * reading the body: a per-IP limit (429) and a size limit (413, by Content-Length or while reading). Neither writes to
 * the database: only counters in memory and a log line with a code (plan 3.1, section 14, point 5). The bytes are then
 * left in req.body as a Buffer; the body parsers skip a request whose stream is already read.
 */
@Injectable()
export class RawBodyRoutes {
  private readonly logger = new Logger('RawBody');
  private readonly routes: RawRoute[] = [];
  readonly counters = { rateLimited: 0, tooLarge: 0 };

  register(prefix: string, opts: { maxBytes: number; perIpPerMinute: number }): void {
    if (!prefix.startsWith('/') || prefix.endsWith('/')) throw new Error('raw body prefix must start and not end with /');
    this.routes.push({ prefix, maxBytes: opts.maxBytes, perIp: new WindowLimiter(opts.perIpPerMinute, 60_000) });
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      const route = this.routes.find((r) => req.path === r.prefix || req.path.startsWith(`${r.prefix}/`));
      if (!route || req.method !== 'POST') return next();
      if (!route.perIp.allow(`${route.prefix}:${req.ip ?? 'unknown'}`)) {
        this.counters.rateLimited++;
        this.logger.warn('raw body route: rate_limited');
        res.setHeader('Retry-After', '60');
        res.status(429).json({ code: 'rate_limited', message: 'Too many requests. Try again later.' });
        return;
      }
      const declared = Number(req.header('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > route.maxBytes) return this.tooLarge(req, res);
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > route.maxBytes) {
          done = true;
          this.tooLarge(req, res);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        (req as Request & { body: unknown }).body = Buffer.concat(chunks, size);
        next();
      });
      req.on('error', () => {
        if (done) return;
        done = true;
        res.status(400).json({ code: 'bad_request', message: 'The request could not be read' });
      });
    };
  }

  private tooLarge(req: Request, res: Response): void {
    this.counters.tooLarge++;
    this.logger.warn('raw body route: too_large');
    res.setHeader('Connection', 'close');
    res.status(413).json({ code: 'payload_too_large', message: 'The request is too large' });
    req.resume();
  }
}
