import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { approveBookingSchema, bookingRequestSchema, closeBookingSchema, listBookingsQuerySchema } from '@mt/shared';
import type { z } from 'zod';
import { OwnedBy, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { PrismaService } from '../../platform/database/prisma.service';
import { unprocessable, notFound } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service';
import { PromoAttemptGuard } from '../pricing';
import { BookingAdminService } from './admin.service';
import { BOOKINGS_PERMISSIONS as P } from './manifest';
import { ownsBookingReference } from './ownership';
import { BookingRequestRateLimitGuard } from './rate-limit.guard';
import { BookingRequestService } from './request.service';
import { customerView } from './views';

type In<T extends z.ZodType> = z.infer<T>;
const uuid = () => new ParseUUIDPipe();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;

/** A customer's booking requests (plan 2.4, sections 4 and 7). The web never sends an amount: the schema has none. */
@Controller('booking-requests')
export class BookingRequestsController {
  constructor(
    @Inject(BookingRequestService) private readonly requests: BookingRequestService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Post()
  @OwnedBy({ kind: 'customer', resource: 'self', publicRefs: ['packageId'] })
  @UseGuards(BookingRequestRateLimitGuard, PromoAttemptGuard)
  async create(@Body(new ZodPipe(bookingRequestSchema)) b: In<typeof bookingRequestSchema>, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw unprocessable('idempotency_key_required', 'Send an Idempotency-Key header (16 to 64 letters, digits or hyphens)');
    const actor = actorOf(req);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { id: true, email: true } });
    const outcome = await this.idempotency.run({ actorType: 'customer', actorId: user.id, route: 'POST /booking-requests', key, body: b }, async () => {
      const r = await this.requests.create(user, b, key, actor);
      return { status: 201, resourceType: 'Booking', resourceId: r.bookingId };
    });
    // No response body is stored: a repeat gets the current representation of the same booking (plan 0.1, 5.1).
    const view = await customerView(this.prisma, { id: outcome.result.resourceId! });
    if (!view) throw notFound('booking_not_found', 'Booking not found');
    return view;
  }

  @Get(':reference')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'booking-request', owns: (ctx) => ownsBookingReference(ctx) })
  async get(@Param('reference') reference: string) {
    const view = await customerView(this.prisma, { reference });
    if (!view) throw notFound('not_found', 'Not found');
    return view;
  }
}

/** The panel's booking routes (plan 2.4, section 7). Each names one permission; cancelling also needs a recent TOTP check. */
@Controller('admin/bookings')
export class BookingsAdminController {
  constructor(@Inject(BookingAdminService) private readonly bookings: BookingAdminService) {}

  @Get() @RequirePermission(P.read)
  list(@Query(new ZodPipe(listBookingsQuerySchema)) q: In<typeof listBookingsQuerySchema>) { return this.bookings.list(q); }

  @Get(':id') @RequirePermission(P.read)
  get(@Param('id', uuid()) id: string) { return this.bookings.get(id); }

  @Post(':id/approve') @HttpCode(200) @RequirePermission(P.approve)
  approve(@Param('id', uuid()) id: string, @Body(new ZodPipe(approveBookingSchema)) b: In<typeof approveBookingSchema>, @Req() req: ApiRequest) {
    return this.bookings.transition(id, 'approve', { actor: actorOf(req), version: b.version, reason: b.reason });
  }

  @Post(':id/decline') @HttpCode(200) @RequirePermission(P.decline)
  decline(@Param('id', uuid()) id: string, @Body(new ZodPipe(closeBookingSchema)) b: In<typeof closeBookingSchema>, @Req() req: ApiRequest) {
    return this.bookings.transition(id, 'decline', { actor: actorOf(req), version: b.version, reason: b.reason });
  }

  @Post(':id/cancel') @HttpCode(200) @RequirePermission(P.cancel)
  cancel(@Param('id', uuid()) id: string, @Body(new ZodPipe(closeBookingSchema)) b: In<typeof closeBookingSchema>, @Req() req: ApiRequest) {
    return this.bookings.transition(id, 'cancel', { actor: actorOf(req), version: b.version, reason: b.reason });
  }
}
