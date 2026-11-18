import { Inject, Injectable } from '@nestjs/common';
import { DASHBOARD_LIST_SIZE, DASHBOARD_PERMISSIONS, DASHBOARD_TASK_DAYS } from '@mt/shared';
import type { DashboardView } from '@mt/shared';
import type { AuthContext } from '../../platform/access/auth-context';
import { AccessService } from '../../platform/access/access.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { AlertsService } from '../alerts';
import { readNewRequestsForDashboard, todayInBrisbane } from '../bookings';
import { readStockForDashboard } from '../catalogue';
import { PENDING_HORIZON_DAYS, PaymentPendingService } from '../payments';

const P = DASHBOARD_PERMISSIONS;
const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return typeof v === 'string' ? v : (o['en-AU'] ?? Object.values(o)[0] ?? '');
};

/**
 * The staff start page (task 5.6): counts and short lists, all from the owning modules. A section is built only when the
 * caller holds the permission that reads its data, so the page never shows more than the lists behind it would.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AlertsService) private readonly alerts: AlertsService,
    @Inject(PaymentPendingService) private readonly pending: PaymentPendingService,
  ) {}

  async view(auth: AuthContext, now: Date = new Date()): Promise<DashboardView> {
    const eff = await this.access.effectiveFor(this.prisma, auth);
    const can = (key: string) => eff.keys.has(key);
    const today = todayInBrisbane(now);
    const sections: DashboardView['sections'] = {};

    if (can(P.newRequests)) {
      const r = await this.prisma.$transaction((tx) => readNewRequestsForDashboard(tx, DASHBOARD_LIST_SIZE));
      sections.newRequests = {
        total: r.total,
        items: r.items.map((i) => ({ ...i, requestedAt: i.requestedAt.toISOString(), requestExpiresAt: i.requestExpiresAt.toISOString() })),
      };
    }
    if (can(P.pendingPayments)) {
      const p = await this.pending.collections(today, DASHBOARD_LIST_SIZE);
      sections.pendingPayments = { overdue: p.overdue, dueSoon: p.dueSoon, horizonDays: PENDING_HORIZON_DAYS, truncated: p.truncated, items: p.items };
    }
    if (can(P.stock)) {
      sections.stock = await this.prisma.$transaction((tx) => readStockForDashboard(tx, DASHBOARD_LIST_SIZE));
    }
    if (can(P.subscribers)) {
      const rows = await this.alerts.subscriberCounts();
      sections.subscribers = {
        confirmed: rows.reduce((n, r) => n + r.confirmed, 0),
        pending: rows.reduce((n, r) => n + r.pending, 0),
        races: rows.slice(0, DASHBOARD_LIST_SIZE).map((r) => ({ raceId: r.raceId, slug: r.slug, raceName: en(r.name), confirmed: r.confirmed, pending: r.pending })),
      };
    }
    if (can(P.tasks)) {
      const soon = new Date(now.getTime() + DASHBOARD_TASK_DAYS * 86_400_000);
      const where = { status: 'open' as const, deletedAt: null, dueAt: { not: null, lte: soon } };
      const [overdue, total, rows] = await Promise.all([
        this.prisma.task.count({ where: { ...where, dueAt: { lt: now } } }),
        this.prisma.task.count({ where }),
        this.prisma.task.findMany({ where, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: DASHBOARD_LIST_SIZE, select: { id: true, title: true, dueAt: true } }),
      ]);
      sections.tasks = {
        overdue, dueSoon: total - overdue,
        items: rows.map((r) => ({ id: r.id, title: r.title, dueAt: r.dueAt!.toISOString(), overdue: r.dueAt!.getTime() < now.getTime() })),
      };
    }
    return { today, generatedAt: now.toISOString(), sections };
  }
}
