import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { FLAGS } from '../flags/flag-registry';
import { FeatureFlagService } from '../flags/flags.service';
import { hasAuthorization } from '../integrations/api-key-token';
import { ApiError } from './api-error';
import type { ApiRequest } from './request-context';

/** Paths that keep working in maintenance mode: liveness, staff sign-in, and the admin API (to see the monitor and switch it off). */
export function isMaintenanceExempt(method: string, path: string): boolean {
  if (method === 'GET' && (path === '/health' || path === '/health/')) return true;
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
