import { Controller, Get, Inject, Query } from '@nestjs/common';
import { listWaitlistQuerySchema } from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { WAITLIST_PERMISSIONS as P } from './manifest';
import { WaitlistService } from './waitlist.service';

/** The panel's waiting list (task 2.6). Joining is not here: it goes through POST /booking-requests. */
@Controller('admin/waitlist')
export class WaitlistAdminController {
  constructor(@Inject(WaitlistService) private readonly waitlist: WaitlistService) {}

  @Get() @RequirePermission(P.read)
  list(@Query(new ZodPipe(listWaitlistQuerySchema)) q: z.infer<typeof listWaitlistQuerySchema>) { return this.waitlist.list(q); }
}
