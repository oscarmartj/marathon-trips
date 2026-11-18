import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import { tripListQuerySchema } from '@mt/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { TRIPOPS_PERMISSIONS as P } from './manifest';
import { TripOpsService, type ListResult } from './tripops.service';
import { contentDisposition } from '../../platform/http/content-disposition';

type Q = z.infer<typeof tripListQuerySchema>;
const id = () => new ParseUUIDPipe();
const query = () => new ZodPipe(tripListQuerySchema);

/** Sends the JSON list, or the CSV as a download. Both are personal data or live data: never cached. */
function send<T>(res: Response, r: ListResult<T>): T | string {
  res.setHeader('Cache-Control', 'no-store');
  if (r.csv === null) return r.data;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition('attachment', r.filename));
  return r.csv;
}

/** The trip lists (task 7.1). One permission for every route; the rooming and transfers lists carry travellers' names. */
@Controller('admin/trip-ops')
export class TripOpsController {
  constructor(@Inject(TripOpsService) private readonly service: TripOpsService) {}

  @Get('trips') @RequirePermission(P.read)
  trips() { return this.service.trips(); }

  @Get('trips/:packageId/rooming-list') @RequirePermission(P.read)
  async rooming(@Param('packageId', id()) packageId: string, @Query(query()) q: Q, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) { return send(res, await this.service.roomingList(actorOf(req), packageId, q.format)); }

  @Get('trips/:packageId/transfers') @RequirePermission(P.read)
  async transfers(@Param('packageId', id()) packageId: string, @Query(query()) q: Q, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) { return send(res, await this.service.transfers(actorOf(req), packageId, q.format)); }

  @Get('trips/:packageId/itinerary') @RequirePermission(P.read)
  async itinerary(@Param('packageId', id()) packageId: string, @Query(query()) q: Q, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) { return send(res, await this.service.itinerary(actorOf(req), packageId, q.format)); }
}
