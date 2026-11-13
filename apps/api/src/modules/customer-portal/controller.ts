import { Controller, Get, Header, Inject, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OwnedBy } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { notFound } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ownsBookingReference } from '../bookings';
import { CustomerAccountService } from './account.service';
import { isDocumentKind } from './documents';
import { DocumentRateLimitGuard } from './rate-limit.guard';

/**
 * The customer area (task 5.1). The list takes nothing but the session; a booking and its documents are found by
 * reference and are the same 404 for an unknown reference and for someone else's (the guard, before anything here runs).
 */
@Controller('account/bookings')
export class CustomerAccountController {
  constructor(@Inject(CustomerAccountService) private readonly account: CustomerAccountService) {}

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
}
