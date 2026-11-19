import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { approveBookingSchema, bookingRequestSchema, staffAmendmentPreviewSchema, staffAmendmentSchema, staffCancelBookingSchema, acceptQuoteSchema, closeBookingSchema, createCustomerSchema, listBookingsQuerySchema, listCustomersQuerySchema, updateCustomerSchema } from '@mt/shared';
import type { z } from 'zod';
import { z as zod } from 'zod';
import { OwnedBy, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { IdempotencyInProgressError, IdempotencyKeyReuseError, IdempotencyService } from '../../platform/idempotency/idempotency.service';
import { PromoAttemptGuard } from '../pricing';
import { WaitlistService, ownsWaitlistEntry } from '../waitlist';
import { WaitlistOffersService } from './waitlist-offers.service';
import { BookingAdminService } from './admin.service';
import { BookingAmendmentService } from './amendment.service';
import { BookingCancellationService } from './cancellation.service';
import { mapLoadError } from './request.service';
import { CustomerAdminService } from './customer-admin.service';
import { BOOKINGS_CRM_PERMISSIONS as C, BOOKINGS_PERMISSIONS as P } from './manifest';
import { ownsBookingReference } from './ownership';
import { BookingRequestRateLimitGuard } from './rate-limit.guard';
import { BookingRequestService } from './request.service';
import { customerView } from './views';

type In<T extends z.ZodType> = z.infer<T>;
const cancellationQuoteQuerySchema = zod.strictObject({ operatorCancelled: zod.enum(['true', 'false']).optional() });
const uuid = () => new ParseUUIDPipe();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;

/** A customer's booking requests (plan 2.4, sections 4 and 7). The web never sends an amount: the schema has none. */
@Controller('booking-requests')
export class BookingRequestsController {
  constructor(
    @Inject(BookingRequestService) private readonly requests: BookingRequestService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WaitlistService) private readonly waitlist: WaitlistService,
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
      return r.kind === 'waitlist'
        ? { status: 201, resourceType: 'WaitlistEntry', resourceId: r.entryId }
        : { status: 201, resourceType: 'Booking', resourceId: r.bookingId };
    }).catch((err: unknown) => {
      // The platform's idempotency errors, as this API's error codes.
      if (err instanceof IdempotencyKeyReuseError) throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');
      if (err instanceof IdempotencyInProgressError) throw conflict('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed');
      throw err;
    });
    // No response body is stored: a repeat gets the current representation of the same booking (plan 0.1, 5.1). A
    // resident gets the request; anyone else gets the waiting list entry, marked `outcome: 'waitlisted'` (task 2.6).
    if (outcome.result.resourceType === 'WaitlistEntry') {
      const entry = await this.waitlist.customerView(outcome.result.resourceId!);
      if (!entry) throw notFound('waitlist_entry_not_found', 'Waiting list entry not found');
      return entry;
    }
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
  constructor(
    @Inject(BookingAdminService) private readonly bookings: BookingAdminService,
    @Inject(BookingAmendmentService) private readonly amendments: BookingAmendmentService,
    @Inject(BookingCancellationService) private readonly cancellations: BookingCancellationService,
  ) {}

  @Get() @RequirePermission(P.read)
  list(@Query(new ZodPipe(listBookingsQuerySchema)) q: In<typeof listBookingsQuerySchema>) { return this.bookings.list(q); }

  @Get('summary') @RequirePermission(P.read)
  summary() { return this.bookings.summary(); }

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

  /** Task 6.4: what cancelling now would keep and give back, with the digest the cancel must send. */
  @Get(':id/cancellation-quote') @RequirePermission(P.read)
  cancellationQuote(@Param('id', uuid()) id: string, @Query(new ZodPipe(cancellationQuoteQuerySchema)) q: In<typeof cancellationQuoteQuerySchema>) {
    return this.cancellations.quote({ id }, 'staff', { operatorCancelled: q.operatorCancelled === 'true' });
  }

  /** Task 6.4: cancels with the penalty of the booking's policy (or none when we cancel it); the API computes both. */
  @Post(':id/cancel') @HttpCode(200) @RequirePermission(P.cancel)
  async cancel(@Param('id', uuid()) id: string, @Body(new ZodPipe(staffCancelBookingSchema)) b: In<typeof staffCancelBookingSchema>, @Req() req: ApiRequest) {
    try {
      await this.cancellations.cancelByStaff(id, b, actorOf(req));
    } catch (err) {
      throw mapLoadError(err);
    }
    return this.bookings.get(id);
  }

  /** Oscar confirms a booking whose deposit is paid (plan 0.1, 6.2; plan 3.2, section 1.5). The answer has the final status. */
  @Post(':id/confirm') @HttpCode(200) @RequirePermission(P.confirm)
  confirm(@Param('id', uuid()) id: string, @Body(new ZodPipe(approveBookingSchema)) b: In<typeof approveBookingSchema>, @Req() req: ApiRequest) {
    return this.bookings.transition(id, 'confirm', { actor: actorOf(req), version: b.version, reason: b.reason });
  }

  /** What a change would do (task 6.3): the engine's price on the booking's basis, the difference and what would be owed. */
  @Post(':id/amendments/preview') @HttpCode(200) @RequirePermission(P.read)
  previewAmendment(@Param('id', uuid()) id: string, @Body(new ZodPipe(staffAmendmentPreviewSchema)) b: In<typeof staffAmendmentPreviewSchema>) {
    return this.amendments.preview({ id }, { initiatedBy: 'staff', ...b });
  }

  /** Applies a previewed change once per Idempotency-Key (task 6.3); the answer is the booking as the panel sees it. */
  @Post(':id/amendments') @RequirePermission(P.amend)
  async amend(@Param('id', uuid()) id: string, @Body(new ZodPipe(staffAmendmentSchema)) b: In<typeof staffAmendmentSchema>, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw unprocessable('idempotency_key_required', 'Send an Idempotency-Key header (16 to 64 letters, digits or hyphens)');
    const r = await this.amendments.apply({ id }, { initiatedBy: 'staff', ...b }, key, actorOf(req));
    // 201 for the change made now; 200 for a replay of one already made (plan section 5, step 2).
    if (!r.created) res.status(200);
    return { created: r.created, amendmentId: r.amendmentId, booking: await this.bookings.get(id) };
  }
}

/** The panel's customers (task 2.5). Notes, tags and history come from the shared table routes of task 0.5. */
@Controller('admin/customers')
export class CustomersAdminController {
  constructor(@Inject(CustomerAdminService) private readonly customers: CustomerAdminService) {}

  @Get() @RequirePermission(C.customerRead)
  list(@Query(new ZodPipe(listCustomersQuerySchema)) q: In<typeof listCustomersQuerySchema>) { return this.customers.list(q); }

  @Post() @RequirePermission(C.customerWrite)
  create(@Body(new ZodPipe(createCustomerSchema)) b: In<typeof createCustomerSchema>, @Req() req: ApiRequest) { return this.customers.create(actorOf(req), b); }

  @Get(':id') @RequirePermission(C.customerRead)
  get(@Param('id', uuid()) id: string) { return this.customers.get(id); }

  @Patch(':id') @RequirePermission(C.customerWrite)
  update(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateCustomerSchema)) b: In<typeof updateCustomerSchema>, @Req() req: ApiRequest) { return this.customers.update(actorOf(req), id, b); }
}

/**
 * A customer's own waiting list entry (task 6.5): see it, take the offer when a place has come up, or leave the list.
 * The routes take no body: the price comes from the engine when the offer is accepted.
 */
@Controller('waitlist/entries')
export class WaitlistEntriesController {
  constructor(@Inject(WaitlistOffersService) private readonly offers: WaitlistOffersService) {}

  @Get(':id')
  @OwnedBy({ kind: 'customer', resource: 'waitlist-entry', fixture: 'waitlist-entry', owns: (ctx) => ownsWaitlistEntry(ctx) })
  get(@Param('id', uuid()) id: string) { return this.offers.view(id); }

  @Post(':id/accept') @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'waitlist-entry', fixture: 'waitlist-entry-accept', owns: (ctx) => ownsWaitlistEntry(ctx) })
  accept(@Param('id', uuid()) id: string, @Body(new ZodPipe(acceptQuoteSchema)) b: In<typeof acceptQuoteSchema>, @Req() req: ApiRequest) {
    const actor = actorOf(req);
    return this.offers.accept(actor.id!, id, actor, b.cancellationPolicy);
  }

  @Post(':id/withdraw') @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'waitlist-entry', fixture: 'waitlist-entry-withdraw', owns: (ctx) => ownsWaitlistEntry(ctx) })
  withdraw(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { const actor = actorOf(req); return this.offers.withdraw(actor.id!, id, actor); }
}
