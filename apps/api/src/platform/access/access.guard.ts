import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../database/prisma.service';
import { readCookie } from '../auth/cookies';
import { SessionService } from '../auth/session.service';
import { ApiError, forbidden, notFound, unauthorised } from '../http/api-error';
import { hasAuthorization } from '../integrations/api-key-token';
import { ApiKeyAuthService } from '../integrations/api-key-auth.service';
import type { ApiRequest } from '../http/request-context';
import { ACCESS_MARK_KEYS, AccessMark } from './access.decorators';
import { AccessService } from './access.service';

/**
 * Every mark on a route, on the handler and on its controller together: a handler mark never hides a controller mark,
 * so two marks at any level make the route invalid (denied, and caught by every_route_has_exactly_one_access_mark).
 */
export function marksOf(reflector: Reflector, handler: object, controller: object): AccessMark[] {
  const read = (target: object) => ACCESS_MARK_KEYS.map((k) => reflector.get<AccessMark | undefined>(k, target as never)).filter((m): m is AccessMark => !!m);
  return [...read(handler), ...read(controller)];
}

/**
 * Global guard (plan 4.1, 4.3). Denies a route without exactly one access mark. Public routes pass; owned routes need
 * a live session of their user kind (from that kind's own cookie); permission routes need a live staff session, the
 * permission, no scope, and a recent TOTP check when the permission requires step-up. A request with an Authorization
 * header is authenticated only by its API key (task 8.4), and only on permission routes.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger('Access');

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // Optional so a test module without it still compiles: then any Authorization header is refused (fail closed).
    @Optional() @Inject(ApiKeyAuthService) private readonly apiKeys?: ApiKeyAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const marks = marksOf(this.reflector, context.getHandler(), context.getClass());
    if (marks.length !== 1) {
      this.logger.error(`route ${context.getClass().name}.${context.getHandler().name} has ${marks.length} access marks; denied`);
      throw forbidden('route_not_marked', 'This route is not available');
    }
    const mark = marks[0]!;
    if (mark.type === 'public') return true;
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (hasAuthorization(req)) {
      // Task 8.4: an API key acts only on permission routes, never as a customer or on "self" routes, and never next
      // to a session cookie (no silent choice between two identities).
      if (mark.type === 'owned') throw unauthorised('api_key_not_allowed', 'API keys cannot be used here');
      if (req.headers.cookie) throw new ApiError(400, 'ambiguous_credentials', 'Send either an API key or a session cookie, not both');
      if (!this.apiKeys) throw unauthorised('invalid_api_key', 'The API key is not valid');
      const keyAuth = await this.apiKeys.authenticate(req);
      req.auth = keyAuth;
      await this.access.assertPermission(this.prisma, keyAuth, mark.key);
      return true;
    }
    const kind = mark.type === 'owned' ? mark.spec.kind : 'staff';
    const auth = await this.sessions.authenticate(kind, readCookie(req, kind, this.sessions.secureCookies));
    if (!auth) throw unauthorised();
    req.auth = auth;
    if (mark.type === 'owned') {
      if (!('owns' in mark.spec)) return true; // resource: 'self'
      if (await mark.spec.owns({ userId: auth.userId, params: req.params as Record<string, string> })) return true;
      throw notFound(); // another customer's resource looks like a missing one
    }
    await this.access.assertPermission(this.prisma, auth, mark.key);
    return true;
  }
}
