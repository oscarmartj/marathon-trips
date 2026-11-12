import { Inject, Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { ACCOUNT_PUBLIC_SELECT, AccountForCall, ProviderGateway, callBlockReason } from './gateway';

export interface RouteQuery {
  method?: PaymentMethod;
  currency: string;
  country: string;
}

/**
 * Minimal routing (plan 3.1, section 2.5): active accounts whose adapter supports the method, currency and country and
 * may take a charge in this environment, oldest first. No fallback chains or limits: RoutingRule arrives with 4.2. In
 * production nothing qualifies today (test accounts and test-only adapters are out), so the flow stops at "no method".
 */
@Injectable()
export class PaymentRouting {
  constructor(@Inject(ProviderGateway) private readonly gateway: ProviderGateway) {}

  async candidates(db: Prisma.TransactionClient, q: RouteQuery): Promise<AccountForCall[]> {
    const accounts = await db.providerAccount.findMany({ where: { status: 'active' }, select: ACCOUNT_PUBLIC_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return accounts.filter((a) => {
      const m = this.gateway.registry.get(a.adapterKey)?.manifest;
      if (!m || callBlockReason(a, m, 'create', this.gateway.env) !== null) return false;
      if (q.method && !m.methods.includes(q.method)) return false;
      if (!m.currencies.includes(q.currency)) return false;
      return m.countries === 'any' || m.countries.includes(q.country);
    });
  }

  async methods(db: Prisma.TransactionClient, q: Omit<RouteQuery, 'method'>): Promise<PaymentMethod[]> {
    const accounts = await this.candidates(db, q);
    const set = new Set<PaymentMethod>();
    for (const a of accounts) for (const m of this.gateway.registry.get(a.adapterKey)!.manifest.methods) set.add(m);
    return [...set].sort();
  }
}
