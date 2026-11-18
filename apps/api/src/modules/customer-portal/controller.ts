import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Inject, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { customerAmendmentPreviewSchema, customerAmendmentSchema, travellerDetailsSchema } from '@mt/shared';
import type { CustomerAmendment, CustomerAmendmentPreview, TravellerDetailsInput } from '@mt/shared';
import { OwnedBy } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { notFound, unprocessable } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { ownsBookingReference } from '../bookings';
import { CustomerAccountService } from './account.service';
import { isDocumentKind } from './documents';
import { CustomerAmendmentsService } from './amendments';
import { AmendmentRateLimitGuard, DocumentRateLimitGuard } from './rate-limit.guard';
import { TravellerDetailsService } from './traveller.service';

/**
 * The customer area (task 5.1). The list takes nothing but the session; a booking and its documents are found by
 * reference and are the same 404 for an unknown reference and for someone else's (the guard, before anything here runs).
 */
@Controller('account/bookings')
export class CustomerAccountController {
  constructor(
    @Inject(CustomerAccountService) private readonly account: CustomerAccountService,
    @Inject(TravellerDetailsService) private readonly travellers: TravellerDetailsService,
    @Inject(CustomerAmendmentsService) private readonly amendments: CustomerAmendmentsService,
  ) {}

  @Get()
  @OwnedBy({ kind: 'customer', resource: 'self' })
  list(@Req() req: ApiRequest) {
    return this.account.list(actorOf(req).id!);
  }

  @Get(':reference')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'account-booking', owns: (ctx) => ownsBookingReference(ctx) })
  detail(@Param('reference') reference: string) {
    return this.account.detail(reference);
  }

  @Get(':reference/documents/:kind')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'account-booking-document', owns: (ctx) => ownsBookingReference(ctx) })
  @UseGuards(DocumentRateLimitGuard)
  @Header('Cache-Control', 'no-store')
  async document(@Param('reference') reference: string, @Param('kind') kind: string, @Res() res: Response) {
    if (!isDocumentKind(kind)) throw notFound();
    const { pdf, filename } = await this.account.document(reference, kind);
    res.status(200).set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' }).send(pdf);
  }

  // Traveller details (task 5.2). The slot is a place number of the booking; anything that is not one is the same 404.

  @Get(':reference/travellers')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'account-booking-travellers', owns: (ctx) => ownsBookingReference(ctx) })
  @Header('Cache-Control', 'no-store')
  travellersOf(@Param('reference') reference: string) {
    return this.travellers.view(reference);
  }

  @Put(':reference/travellers/:slot')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'account-booking-traveller-save', owns: (ctx) => ownsBookingReference(ctx) })
  @Header('Cache-Control', 'no-store')
  saveTraveller(@Param('reference') reference: string, @Param('slot') slot: string, @Body(new ZodPipe(travellerDetailsSchema)) body: TravellerDetailsInput, @Req() req: ApiRequest) {
    return this.travellers.save(actorOf(req), reference, slotOf(slot), body);
  }

  @Delete(':reference/travellers/:slot')
  @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'account-booking-traveller-clear', owns: (ctx) => ownsBookingReference(ctx) })
  @Header('Cache-Control', 'no-store')
  clearTraveller(@Param('reference') reference: string, @Param('slot') slot: string, @Req() req: ApiRequest) {
    return this.travellers.clear(actorOf(req), reference, slotOf(slot));
  }

  // Changes (task 6.3): nights and extras only; the price, the difference and what is owed come from the API.

  @Post(':reference/amendments/preview')
  @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'account-booking-amendment-preview', owns: (ctx) => ownsBookingReference(ctx) })
  @UseGuards(AmendmentRateLimitGuard)
  @Header('Cache-Control', 'no-store')
  previewAmendment(@Param('reference') reference: string, @Body(new ZodPipe(customerAmendmentPreviewSchema)) body: CustomerAmendmentPreview) {
    return this.amendments.preview(reference, body);
  }

  @Post(':reference/amendments')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'account-booking-amendment', owns: (ctx) => ownsBookingReference(ctx) })
  @UseGuards(AmendmentRateLimitGuard)
  @Header('Cache-Control', 'no-store')
  async amend(@Param('reference') reference: string, @Body(new ZodPipe(customerAmendmentSchema)) body: CustomerAmendment, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw unprocessable('idempotency_key_required', 'Send an Idempotency-Key header (16 to 64 letters, digits or hyphens)');
    const r = await this.amendments.apply(reference, body, key, actorOf(req));
    // 201 for the change made now; 200 for a replay of one already made (plan section 5, step 2).
    if (!r.created) res.status(200);
    return { created: r.created, ...(await this.account.detail(reference)) };
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;

/** A place number: digits only, 1 to 80 (the most places a booking can hold). Anything else is not found. */
function slotOf(raw: string): number {
  const n = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > 80) throw notFound();
  return n;
}
