import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound } from '../../platform/http/api-error';
import { ACCOUNT_VIEW_SELECT } from './core/accounts.service';
import { ProviderGateway } from './core/gateway';

const str = (v: bigint) => v.toString();
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Read-only panel views (plan 3.1, section 7): no raw bodies, no headers, no secret column, amounts as strings. */
@Injectable()
export class PaymentAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
  ) {}

  async bookingPayments(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId }, select: { id: true, reference: true, status: true, currency: true } });
    if (!booking) throw notFound('booking_not_found', 'Booking not found');
    const schedule = await this.prisma.paymentSchedule.findUnique({
      where: { bookingId },
      select: { id: true, version: true, items: { orderBy: [{ planVersion: 'asc' }, { sequence: 'asc' }], select: { id: true, kind: true, sequence: true, planVersion: true, amountMinor: true, dueDate: true, state: true, supersededInVersion: true } } },
    });
    const payments = await this.prisma.payment.findMany({
      where: { bookingId }, orderBy: { attemptNumber: 'asc' },
      select: { id: true, attemptNumber: true, origin: true, method: true, mode: true, adapterKey: true, amountMinor: true, currency: true, status: true, providerPaymentRef: true, failureCode: true, pendingExpiresAt: true, succeededAt: true, createdAt: true, targetScheduleItemId: true },
    });
    const events = await this.prisma.webhookEvent.findMany({ where: { bookingId }, orderBy: { receivedAt: 'asc' }, select: { id: true, paymentId: true, type: true, status: true, receivedAt: true, processedAt: true, errorCode: true } });
    return {
      booking: { ...booking, mode: this.gateway.mode },
      schedule: schedule ? { id: schedule.id, version: schedule.version, items: schedule.items.map((i) => ({ ...i, amountMinor: str(i.amountMinor), dueDate: day(i.dueDate) })) } : null,
      payments: payments.map((p) => ({ ...p, amountMinor: str(p.amountMinor) })),
      webhookEvents: events,
    };
  }

  async accounts() {
    const rows = await this.prisma.providerAccount.findMany({ select: ACCOUNT_VIEW_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((r) => {
      const m = this.gateway.registry.get(r.adapterKey)?.manifest;
      return { ...r, adapterStatus: m?.status ?? 'unknown', adapterTestOnly: m?.testOnly ?? true };
    });
  }
}
