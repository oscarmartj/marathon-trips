import { Inject, Injectable } from '@nestjs/common';
import { MARKETING_WORDING_KEY } from '@mt/shared';
import type { AccountPrivacyView } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { CustomerService } from '../bookings';
import { ConsentService } from './consent.service';
import { ErasureService } from './erasure.service';
import type { ExportSubject } from './export.service';

type Tx = Prisma.TransactionClient;

interface Me {
  user: { id: string; email: string };
  customer: { id: string; closed: boolean } | null;
}

/**
 * The customer's own privacy page (task 5.5, plan section 7). Every action first locks the customer of the session's
 * user, or links a staff-created customer with the verified address (CustomerService.lockForUser, the 2.4 helper), and
 * never creates one: without a customer record, consent is kept by address hash and the export holds the account data.
 */
@Injectable()
export class AccountPrivacyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CustomerService) private readonly customers: CustomerService,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(ErasureService) private readonly erasure: ErasureService,
  ) {}

  private async me(tx: Tx, userId: string, actor: AuditActor): Promise<Me> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, kind: true, anonymisedAt: true } });
    if (!user || user.kind !== 'customer' || user.anonymisedAt) throw notFound();
    const c = await this.customers.lockForUser(tx, user, actor);
    return { user: { id: user.id, email: user.email }, customer: c ? { id: c.id, closed: !!(c.anonymisedAt || c.deletedAt) } : null };
  }

  private open(me: Me): string | null {
    if (me.customer?.closed) throw conflict('customer_closed', 'This account is closed');
    return me.customer?.id ?? null;
  }

  async view(userId: string, actor: AuditActor): Promise<AccountPrivacyView> {
    return runTransaction(this.prisma, async (tx) => {
      const me = await this.me(tx, userId, actor);
      const customerId = this.open(me);
      const state = await this.consent.current(tx, { customerId, emailHash: this.consent.hashOf(me.user.email) });
      const req = customerId ? await tx.privacyRequest.findFirst({ where: { customerId, kind: 'erasure', status: 'received' }, select: { status: true, requestedAt: true } }) : null;
      return {
        hasCustomerRecord: customerId !== null,
        marketingConsent: { granted: state.granted, recordedAt: state.recordedAt?.toISOString() ?? null },
        wordingKey: MARKETING_WORDING_KEY,
        erasureRequest: req ? { status: req.status, requestedAt: req.requestedAt.toISOString() } : null,
      };
    });
  }

  async setMarketingConsent(userId: string, granted: boolean, wordingKey: string, actor: AuditActor): Promise<{ granted: boolean }> {
    this.consent.assertWording(wordingKey);
    await runTransaction(this.prisma, async (tx) => {
      const me = await this.me(tx, userId, actor);
      await this.consent.change(tx, { customerId: this.open(me), email: me.user.email }, granted, 'account', actor);
    });
    return { granted };
  }

  /** With a customer record: a request for staff. Without one: the sign-in account is erased now, after confirmation. */
  async requestErasure(userId: string, confirm: boolean, actor: AuditActor): Promise<{ status: 'received' | 'completed'; requestedAt: string }> {
    const outcome = await runTransaction(this.prisma, async (tx) => {
      const me = await this.me(tx, userId, actor);
      const customerId = this.open(me);
      if (!customerId) return null;
      const r = await this.erasure.requestByCustomer(tx, customerId, actor);
      return { status: r.status, requestedAt: r.requestedAt.toISOString() };
    });
    if (outcome) return outcome;
    if (!confirm) throw unprocessable('confirmation_required', 'Confirm that you want to delete your sign-in account');
    await this.erasure.eraseAccount(userId, actor);
    return { status: 'completed', requestedAt: new Date().toISOString() };
  }

  /** Who the export is about, read (and locked) the same way as every other action here. */
  async exportSubject(userId: string, actor: AuditActor): Promise<ExportSubject> {
    return runTransaction(this.prisma, async (tx) => {
      const me = await this.me(tx, userId, actor);
      const customerId = this.open(me);
      const emails = new Set([me.user.email.toLowerCase()]);
      if (customerId) {
        const c = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true } });
        emails.add(c.email.toLowerCase());
      }
      return { customerId, userId: me.user.id, emails: [...emails] };
    });
  }
}
