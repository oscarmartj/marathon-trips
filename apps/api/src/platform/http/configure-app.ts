import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from '../config/config';
import { ApiErrorFilter } from './error.filter';
import { requestContext } from './request-context';

/** Applied by main.ts and by tests, so both run the same HTTP stack. */
export function configureApp(app: INestApplication, config: AppConfig): void {
  const express = app as NestExpressApplication;
  // X-Forwarded-For counts only from a proxy the configuration names (TRUST_PROXY); false by default.
  express.set('trust proxy', config.TRUST_PROXY);
  express.disable('x-powered-by');
  app.use(requestContext);
  app.useGlobalFilters(new ApiErrorFilter());
  // No CORS: the browser only talks to the web app, which proxies /api on the same origin (plan 4.1).
}
