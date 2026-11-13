import { Inject, Injectable } from '@nestjs/common';
import type { CustomerAmendment, CustomerAmendmentPreview } from '@mt/shared';
import type { AuditActor } from '../../platform/audit/audit.service';
import { AuditService } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound } from '../../platform/http/api-error';
import { BookingAmendmentHooks, BookingAmendmentService } from '../bookings';
import type { AmendmentPlacesContext } from '../bookings';
import { TermsService } from '../payments';
import type { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * A customer's own changes to a booking (task 6.3; plan docs/plans/6.3-booking-amendments.md, decision 6): nights and
 * extras only, never a lower price, with the booking terms accepted. Also customer-portal's step inside every change:
 * traveller details of replaced places are carried and those of retired places deleted (plan section 7).
 */
@Injectable()
export class CustomerAmendmentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BookingAmendmentService) private readonly amendments: BookingAmendmentService,
    @Inject(TermsService) private readonly terms: TermsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  register(hooks: BookingAmendmentHooks): void {
    hooks.registerPlaces((tx, ctx) => this.onPlaces(tx, ctx));
  }

  preview(reference: string, body: CustomerAmendmentPreview) {
    return this.amendments.preview({ reference }, { initiatedBy: 'customer', ...body });
  }

  async apply(reference: string, body: CustomerAmendment, key: string, actor: AuditActor) {
    const b = await this.prisma.booking.findUnique({ where: { reference }, select: { id: true } });
    if (!b) throw notFound();
    // The change is part of the contract: the booking terms in force must be accepted (task 3.5's acceptance).
    await this.terms.assertAccepted(b.id);
    const { acceptNewPrice: _accepted, ...rest } = body;
    return this.amendments.apply({ reference }, { initiatedBy: 'customer', ...rest }, key, actor);
  }

  /**
   * Details of a replaced place go to the place that replaces it: names and emergency contact always, the date of birth
   * only for a runner, the estimated finish time never (it belongs to a distance). Then the details of every retired
   * place are deleted (data minimisation). The audit entries carry no values.
   */
  private async onPlaces(tx: Tx, ctx: AmendmentPlacesContext): Promise<void> {
    for (const c of ctx.carries) {
      const from = await tx.traveller.findUnique({ where: { bookingId_slot: { bookingId: ctx.bookingId, slot: c.from } } });
      if (!from || from.anonymisedAt) continue;
      const row = await tx.traveller.create({
        data: {
          bookingId: ctx.bookingId, customerId: ctx.customerId, slot: c.to, givenName: from.givenName, familyName: from.familyName,
          dateOfBirth: c.runner ? from.dateOfBirth : null, emergencyContactName: from.emergencyContactName, emergencyContactPhone: from.emergencyContactPhone, estimatedFinishSeconds: null,
        },
        select: { id: true },
      });
      await this.audit.record(tx, { actor: ctx.actor, action: 'customerPortal.traveller.carried', entityType: 'Traveller', entityId: row.id, context: { bookingId: ctx.bookingId, fromSlot: c.from, toSlot: c.to } });
    }
    if (ctx.retired.length === 0) return;
    const gone = await tx.traveller.findMany({ where: { bookingId: ctx.bookingId, slot: { in: ctx.retired } }, select: { id: true, slot: true } });
    for (const g of gone) {
      await tx.traveller.delete({ where: { id: g.id } });
      await this.audit.record(tx, { actor: ctx.actor, action: 'customerPortal.traveller.retired', entityType: 'Traveller', entityId: g.id, context: { bookingId: ctx.bookingId, slot: g.slot } });
    }
  }
}
