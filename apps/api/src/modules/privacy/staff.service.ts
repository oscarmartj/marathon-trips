import { Inject, Injectable } from '@nestjs/common';
import type { StaffPrivacyView } from '@mt/shared';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound } from '../../platform/http/api-error';
import { ConsentService } from './consent.service';
import { ErasureService } from './erasure.service';
import type { ExportSubject } from './export.service';

/** What the panel shows about a customer's privacy (task 5.5, plan section 7): states and dates, never an address. */
@Injectable()
export class StaffPrivacyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(ErasureService) private readonly erasure: ErasureService,
  ) {}

  async view(customerId: string): Promise<StaffPrivacyView> {
    const c = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { email: true, anonymisedAt: true } });
    if (!c) throw notFound();
    const state = await this.consent.current(this.prisma, { customerId, emailHash: this.consent.hashOf(c.email) });
    const history = await this.consent.history(this.prisma, customerId, c.email);
    const requests = await this.prisma.privacyRequest.findMany({
      where: { customerId }, orderBy: { requestedAt: 'desc' }, take: 50,
      select: { kind: true, status: true, requestedBy: true, requestedAt: true, completedAt: true },
    });
    const blockedBy = c.anonymisedAt ? null : await this.erasure.blockedBy(this.prisma, customerId);
    return {
      anonymised: c.anonymisedAt !== null,
      marketingConsent: { granted: state.granted, recordedAt: state.recordedAt?.toISOString() ?? null },
      consentHistory: history.map((h) => ({ granted: h.granted, source: h.source, recordedAt: h.recordedAt.toISOString() })),
      requests: requests.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null })),
      erasure: { possible: !c.anonymisedAt && blockedBy === null, blockedBy },
    };
  }

  async exportSubject(customerId: string): Promise<ExportSubject> {
    const c = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { email: true, userId: true, user: { select: { email: true } } } });
    if (!c) throw notFound();
    return { customerId, userId: c.userId, emails: [...new Set([c.email, c.user?.email].filter((e): e is string => !!e).map((e) => e.toLowerCase()))] };
  }
}
