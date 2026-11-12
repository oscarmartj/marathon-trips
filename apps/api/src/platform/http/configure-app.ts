import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '../config/config';
import { ApiErrorFilter } from './error.filter';
import { RawBodyRoutes } from './raw-body';
import { requestContext } from './request-context';

/** Applied by main.ts and by tests, so both run the same HTTP stack. */
export function configureApp(app: INestApplication, config: AppConfig): void {
  const express = app as NestExpressApplication;
  // X-Forwarded-For counts only from a proxy the configuration names (TRUST_PROXY); false by default.
  express.set('trust proxy', config.TRUST_PROXY);
  express.disable('x-powered-by');
  app.use(requestContext);
  // Before the body parsers and every guard: the exact bytes, rate and size limits of the raw-body routes (task 3.1).
  // A test app without PlatformModule has none; then raw-body routes get no Buffer and refuse every request (400).
  const raw = rawBodyRoutesOf(app);
  if (raw) app.use(raw.middleware());
  app.useGlobalFilters(new ApiErrorFilter());
  // No CORS: the browser only talks to the web app, which proxies /api on the same origin (plan 4.1).
}

function rawBodyRoutesOf(app: INestApplication): RawBodyRoutes | null {
  try {
    return app.get(RawBodyRoutes, { strict: false });
  } catch {
    return null;
  }
}
