import type { AuditActor } from '../audit/audit.service';
import { unauthorised } from '../http/api-error';
import type { ApiRequest } from '../http/request-context';

/** The audit actor of an authenticated request (set by AccessGuard). */
export function actorOf(req: ApiRequest): AuditActor & { id: string } {
  if (!req.auth) throw unauthorised();
  return { type: req.auth.kind, id: req.auth.userId, sessionId: req.auth.sessionId, requestId: req.requestId };
}
