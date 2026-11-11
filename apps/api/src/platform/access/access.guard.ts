import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../database/prisma.service';
import { readCookie } from '../auth/cookies';
import { SessionService } from '../auth/session.service';
import { forbidden, notFound, unauthorised } from '../http/api-error';
import type { ApiRequest } from '../http/request-context';
import { ACCESS_MARK_KEYS, AccessMark } from './access.decorators';
import { AccessService } from './access.service';

/** The marks on a route: the handler's if it has any, otherwise the controller's. */
export function marksOf(reflector: Reflector, handler: object, controller: object): AccessMark[] {
  const read = (target: object) => ACCESS_MARK_KEYS.map((k) => reflector.get<AccessMark | undefined>(k, target as never)).filter((m): m is AccessMark => !!m);
  const own = read(handler);
  return own.length > 0 ? own : read(controller);
}

/**
 * Global guard (plan 4.1, 4.3). Denies a route without exactly one access mark. Public routes pass; owned routes need
 * a live session of their user kind (from that kind's own cookie); permission routes need a live staff session, the
 * permission, no scope, and a recent TOTP check when the permission requires step-up.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger('Access');

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
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
