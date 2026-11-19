import { Inject, Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { MANUAL_KEY } from '../adapters/manual/manual';
import { ACCOUNT_PUBLIC_SELECT, AccountForCall, ProviderGateway, callBlockReason } from './gateway';
import { ManualMethodsService } from './manual-methods.service';

export interface RouteQuery {
  method?: PaymentMethod;
  currency: string;
  country: string;
}

/**
 * Minimal routing (plan 3.1, section 2.5): active accounts whose adapter supports the method, currency and country and
 * may take a charge in this environment, oldest first. No fallback chains or limits: RoutingRule arrives with 4.2. In
 * production nothing qualifies today (test accounts and test-only adapters are out), so the flow stops at "no method".
 * A manual account (task 3.4) offers a method only while that method is switched on for the customer's country and its
 * payee details are valid.
 */
@Injectable()
export class PaymentRouting {
  constructor(
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(ManualMethodsService) private readonly manual: ManualMethodsService,
  ) {}

  async candidates(db: Prisma.TransactionClient, q: RouteQuery): Promise<AccountForCall[]> {
    const accounts = await db.providerAccount.findMany({ where: { status: 'active' }, select: ACCOUNT_PUBLIC_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const out: AccountForCall[] = [];
    for (const a of accounts) {
      const m = this.gateway.registry.get(a.adapterKey)?.manifest;
      if (!m || callBlockReason(a, m, 'create', this.gateway.env) !== null) continue;
      if (q.method && !m.methods.includes(q.method)) continue;
      if (!m.currencies.includes(q.currency)) continue;
      if (m.countries !== 'any' && !m.countries.includes(q.country)) continue;
      if (a.adapterKey === MANUAL_KEY) {
        if (!q.method || !(await this.manual.offered(db, q.method, q.country))) continue;
      }
      out.push(a);
    }
    return out;
  }

  async methods(db: Prisma.TransactionClient, q: Omit<RouteQuery, 'method'>): Promise<PaymentMethod[]> {
    const accounts = await this.candidatesAnyMethod(db, q);
    const set = new Set<PaymentMethod>();
    for (const a of accounts) {
      const manifest = this.gateway.registry.get(a.adapterKey)!.manifest;
      for (const m of manifest.methods) {
        if (a.adapterKey === MANUAL_KEY && !(await this.manual.offered(db, m, q.country))) continue;
        set.add(m);
      }
    }
    return [...set].sort();
  }

  /** Accounts that could take this currency and country, whatever the method (manual accounts are filtered per method later). */
  private async candidatesAnyMethod(db: Prisma.TransactionClient, q: Omit<RouteQuery, 'method'>): Promise<AccountForCall[]> {
    const accounts = await db.providerAccount.findMany({ where: { status: 'active' }, select: ACCOUNT_PUBLIC_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return accounts.filter((a) => {
      const m = this.gateway.registry.get(a.adapterKey)?.manifest;
      if (!m || callBlockReason(a, m, 'create', this.gateway.env) !== null) return false;
      if (!m.currencies.includes(q.currency)) return false;
      return m.countries === 'any' || m.countries.includes(q.country);
    });
  }
}
