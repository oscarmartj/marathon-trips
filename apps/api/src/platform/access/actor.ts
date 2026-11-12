import type { AuditActor } from '../audit/audit.service';
import { unauthorised } from '../http/api-error';
import type { ApiRequest } from '../http/request-context';
import type { SessionAuth } from './auth-context';

/**
 * The audit actor of an authenticated request (set by AccessGuard). An API key acts as itself: type api_key and the
 * key's id (the key row says whose it is and never changes), with no session (task 8.4).
 */
export function actorOf(req: ApiRequest): AuditActor & { id: string } {
  const auth = req.auth;
  if (!auth) throw unauthorised();
  if (auth.via === 'api_key') return { type: 'api_key', id: auth.apiKeyId, sessionId: null, requestId: req.requestId };
  return { type: auth.kind, id: auth.userId, sessionId: auth.sessionId, requestId: req.requestId };
}

/** The session behind a "self" route (sign-out, step-up). API keys never reach those routes; this only narrows the type. */
export function sessionOf(req: ApiRequest): SessionAuth {
  const auth = req.auth;
  if (!auth || auth.via !== 'session') throw unauthorised();
  return auth;
}
