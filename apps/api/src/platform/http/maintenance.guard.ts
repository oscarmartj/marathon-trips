import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { FLAGS } from '../flags/flag-registry';
import { FeatureFlagService } from '../flags/flags.service';
import { hasAuthorization } from '../integrations/api-key-token';
import { ApiError } from './api-error';
import type { ApiRequest } from './request-context';

/**
 * Paths that keep working in maintenance mode: liveness, staff sign-in, the admin API (to see the monitor and switch it
 * off), and one-click unsubscribe (task 5.5: an unsubscribe must work whenever it is sent, Spam Act 2003).
 */
export function isMaintenanceExempt(method: string, path: string): boolean {
  if (method === 'GET' && (path === '/health' || path === '/health/')) return true;
  if (method === 'POST' && /^\/unsubscribe\/[^/]+$/.test(path)) return true;
  return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/auth/staff/');
}

/**
 * Task 8.6. First global guard. While the `platform.maintenance` flag is on, every other request gets 503 with a fixed
 * code and Retry-After. The flag is read on every request (no restart, no cache), and a failed read is a 500, never
 * "open". Background jobs keep running.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(@Inject(FeatureFlagService) private readonly flags: FeatureFlagService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<ApiRequest>();
    // The admin API stays open for staff sessions; API keys wait until maintenance is over (task 8.4).
    if (isMaintenanceExempt(req.method, req.path) && (!hasAuthorization(req) || req.path.startsWith('/health'))) return true;
    if (!(await this.flags.isEnabled(FLAGS.maintenance))) return true;
    throw new ApiError(503, 'maintenance', 'The site is down for maintenance. Please try again shortly.', { 'Retry-After': '120' });
  }
}
