import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  addPackageHotelSchema, adminPackageQuerySchema, adminRaceQuerySchema, catalogueExportBodySchema, csvImportSchema, duplicatePackageSchema, createEditionSchema, createExtraSchema, createHotelSchema, createPackageSchema, createPoolSchema, createRaceSchema, distanceSchema,
  editionStatusChangeSchema, entryOptionSchema, raceStatusChangeSchema, roomOptionSchema, saleStatusChangeSchema, setClaimSchema, setParticipationSchema, updateDistanceSchema,
  updateEditionSchema, updateExtraSchema, updateRoomOptionSchema, updateHotelSchema, updatePackageSchema, updatePoolSchema, updateRaceSchema, CLAIM_KINDS,
} from '@mt/shared';
import type { ClaimKind } from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import type { ApiRequest } from '../../platform/http/request-context';
import { notFound } from '../../platform/http/api-error';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { CatalogueCsvService } from './csv.service';
import { InventoryService } from './inventory.service';
import { CATALOGUE_PERMISSIONS as P } from './manifest';
import { CataloguePanelService } from './panel.service';
import { PackageService } from './package.service';
import { RaceService } from './race.service';

const uuid = () => new ParseUUIDPipe();
const claimKind = (k: string): ClaimKind => {
  if (!(CLAIM_KINDS as readonly string[]).includes(k)) throw notFound('not_found', 'Not found');
  return k as ClaimKind;
};
type In<T extends z.ZodType> = z.infer<T>;

/** The panel's catalogue routes. Every route names one permission; claims also need a recent TOTP check. */
@Controller('admin/catalogue')
export class CatalogueAdminController {
  constructor(
    @Inject(RaceService) private readonly races: RaceService,
    @Inject(PackageService) private readonly packages: PackageService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(CataloguePanelService) private readonly panel: CataloguePanelService,
    @Inject(CatalogueCsvService) private readonly csv: CatalogueCsvService,
  ) {}

  // ---- Races ----
  @Post('races/export') @HttpCode(200) @RequirePermission(P.raceRead)
  async exportRaces(@Body(new ZodPipe(catalogueExportBodySchema)) _b: In<typeof catalogueExportBodySchema>, @Res({ passthrough: true }) res: Response) { return this.sendCsv(res, 'races', (await this.csv.exportRaces()).csv); }

  @Post('races/import') @HttpCode(200) @RequirePermission(P.raceManage)
  importRaces(@Body(new ZodPipe(csvImportSchema)) b: In<typeof csvImportSchema>, @Req() req: ApiRequest) { return this.csv.importRaces(actorOf(req), b); }

  @Get('races') @RequirePermission(P.raceRead)
  listRaces(@Query(new ZodPipe(adminRaceQuerySchema)) q: In<typeof adminRaceQuerySchema>) { return this.races.list(q); }

  @Get('races/:id') @RequirePermission(P.raceRead)
  getRace(@Param('id', uuid()) id: string) { return this.races.get(id); }

  @Post('races') @RequirePermission(P.raceManage)
  createRace(@Body(new ZodPipe(createRaceSchema)) b: In<typeof createRaceSchema>, @Req() req: ApiRequest) { return this.races.create(actorOf(req), b); }

  @Patch('races/:id') @RequirePermission(P.raceManage)
  updateRace(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateRaceSchema)) b: In<typeof updateRaceSchema>, @Req() req: ApiRequest) { return this.races.update(actorOf(req), id, b); }

  @Post('races/:id/status') @HttpCode(200) @RequirePermission(P.raceManage)
  raceStatus(@Param('id', uuid()) id: string, @Body(new ZodPipe(raceStatusChangeSchema)) b: In<typeof raceStatusChangeSchema>, @Req() req: ApiRequest) { return this.races.setStatus(actorOf(req), id, b); }

  @Delete('races/:id') @HttpCode(204) @RequirePermission(P.raceManage)
  async deleteRace(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.races.remove(actorOf(req), id); }

  @Post('races/:id/distances') @RequirePermission(P.raceManage)
  addDistance(@Param('id', uuid()) id: string, @Body(new ZodPipe(distanceSchema)) b: In<typeof distanceSchema>, @Req() req: ApiRequest) { return this.races.addDistance(actorOf(req), id, b); }

  @Patch('distances/:id') @RequirePermission(P.raceManage)
  updateDistance(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateDistanceSchema)) b: In<typeof updateDistanceSchema>, @Req() req: ApiRequest) { return this.races.updateDistance(actorOf(req), id, b); }

  @Delete('distances/:id') @HttpCode(204) @RequirePermission(P.raceManage)
  async deleteDistance(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.races.removeDistance(actorOf(req), id); }

  @Put('races/:id/claims/:kind') @RequirePermission(P.claimManage)
  setClaim(@Param('id', uuid()) id: string, @Param('kind') kind: string, @Body(new ZodPipe(setClaimSchema)) b: In<typeof setClaimSchema>, @Req() req: ApiRequest) { return this.races.setClaim(actorOf(req), id, claimKind(kind), b); }

  // ---- Editions ----
  @Post('races/:id/editions') @RequirePermission(P.raceManage)
  createEdition(@Param('id', uuid()) id: string, @Body(new ZodPipe(createEditionSchema)) b: In<typeof createEditionSchema>, @Req() req: ApiRequest) { return this.races.createEdition(actorOf(req), id, b); }

  @Get('editions/:id') @RequirePermission(P.raceRead)
  getEdition(@Param('id', uuid()) id: string) { return this.races.getEdition(id); }

  @Patch('editions/:id') @RequirePermission(P.raceManage)
  updateEdition(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateEditionSchema)) b: In<typeof updateEditionSchema>, @Req() req: ApiRequest) { return this.races.updateEdition(actorOf(req), id, b); }

  @Post('editions/:id/status') @HttpCode(200) @RequirePermission(P.raceManage)
  editionStatus(@Param('id', uuid()) id: string, @Body(new ZodPipe(editionStatusChangeSchema)) b: In<typeof editionStatusChangeSchema>, @Req() req: ApiRequest) { return this.races.setEditionStatus(actorOf(req), id, b); }

  @Delete('editions/:id') @HttpCode(204) @RequirePermission(P.raceManage)
  async deleteEdition(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.races.removeEdition(actorOf(req), id); }

  // ---- Packages ----
  @Post('editions/:id/packages/export') @HttpCode(200) @RequirePermission(P.packageRead)
  async exportPackages(@Param('id', uuid()) id: string, @Body(new ZodPipe(catalogueExportBodySchema)) _b: In<typeof catalogueExportBodySchema>, @Res({ passthrough: true }) res: Response) { return this.sendCsv(res, 'packages', (await this.csv.exportPackages(id)).csv); }

  @Post('editions/:id/packages/import') @HttpCode(200) @RequirePermission(P.packageManage)
  importPackages(@Param('id', uuid()) id: string, @Body(new ZodPipe(csvImportSchema)) b: In<typeof csvImportSchema>, @Req() req: ApiRequest) { return this.csv.importPackages(actorOf(req), id, b); }

  @Get('packages') @RequirePermission(P.packageRead)
  listPackages(@Query(new ZodPipe(adminPackageQuerySchema)) q: In<typeof adminPackageQuerySchema>) { return this.panel.listPackages(q); }

  @Get('packages/:id/preview') @RequirePermission(P.packageRead)
  previewPackage(@Param('id', uuid()) id: string) { return this.panel.preview(id); }

  @Post('packages/:id/duplicate') @RequirePermission(P.packageManage)
  duplicatePackage(@Param('id', uuid()) id: string, @Body(new ZodPipe(duplicatePackageSchema)) b: In<typeof duplicatePackageSchema>, @Req() req: ApiRequest) { return this.packages.duplicate(actorOf(req), id, b); }

  @Get('low-stock') @RequirePermission(P.packageRead)
  lowStock() { return this.panel.lowStock(); }

  @Post('editions/:id/packages') @RequirePermission(P.packageManage)
  createPackage(@Param('id', uuid()) id: string, @Body(new ZodPipe(createPackageSchema)) b: In<typeof createPackageSchema>, @Req() req: ApiRequest) { return this.packages.create(actorOf(req), id, b); }

  @Get('packages/:id') @RequirePermission(P.packageRead)
  getPackage(@Param('id', uuid()) id: string) { return this.packages.get(id); }

  @Patch('packages/:id') @RequirePermission(P.packageManage)
  updatePackage(@Param('id', uuid()) id: string, @Body(new ZodPipe(updatePackageSchema)) b: In<typeof updatePackageSchema>, @Req() req: ApiRequest) { return this.packages.update(actorOf(req), id, b); }

  @Post('packages/:id/sale-status') @HttpCode(200) @RequirePermission(P.packageSetSaleStatus)
  saleStatus(@Param('id', uuid()) id: string, @Body(new ZodPipe(saleStatusChangeSchema)) b: In<typeof saleStatusChangeSchema>, @Req() req: ApiRequest) { return this.packages.setSaleStatus(actorOf(req), id, b); }

  @Delete('packages/:id') @HttpCode(204) @RequirePermission(P.packageManage)
  async deletePackage(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.packages.remove(actorOf(req), id); }

  @Put('packages/:id/participation') @RequirePermission(P.packageManage)
  setParticipation(@Param('id', uuid()) id: string, @Body(new ZodPipe(setParticipationSchema)) b: In<typeof setParticipationSchema>, @Req() req: ApiRequest) { return this.packages.setParticipation(actorOf(req), id, b); }

  @Post('packages/:id/entry-options') @RequirePermission(P.packageManage)
  addEntry(@Param('id', uuid()) id: string, @Body(new ZodPipe(entryOptionSchema)) b: In<typeof entryOptionSchema>, @Req() req: ApiRequest) { return this.packages.addEntryOption(actorOf(req), id, b); }

  @Delete('packages/:id/entry-options/:entryId') @RequirePermission(P.packageManage)
  removeEntry(@Param('id', uuid()) id: string, @Param('entryId', uuid()) entryId: string, @Req() req: ApiRequest) { return this.packages.removeEntryOption(actorOf(req), id, entryId); }

  @Post('packages/:id/hotels') @RequirePermission(P.packageManage)
  addHotel(@Param('id', uuid()) id: string, @Body(new ZodPipe(addPackageHotelSchema)) b: In<typeof addPackageHotelSchema>, @Req() req: ApiRequest) { return this.packages.addHotel(actorOf(req), id, b); }

  @Delete('packages/:id/hotels/:packageHotelId') @RequirePermission(P.packageManage)
  removeHotelLink(@Param('id', uuid()) id: string, @Param('packageHotelId', uuid()) ph: string, @Req() req: ApiRequest) { return this.packages.removeHotel(actorOf(req), id, ph); }

  @Post('packages/:id/hotels/:packageHotelId/rooms') @RequirePermission(P.packageManage)
  addRoom(@Param('id', uuid()) id: string, @Param('packageHotelId', uuid()) ph: string, @Body(new ZodPipe(roomOptionSchema)) b: In<typeof roomOptionSchema>, @Req() req: ApiRequest) { return this.packages.addRoom(actorOf(req), id, ph, b); }

  @Patch('packages/:id/rooms/:roomId') @RequirePermission(P.packageManage)
  updateRoom(@Param('id', uuid()) id: string, @Param('roomId', uuid()) roomId: string, @Body(new ZodPipe(updateRoomOptionSchema)) b: In<typeof updateRoomOptionSchema>, @Req() req: ApiRequest) { return this.packages.updateRoom(actorOf(req), id, roomId, b); }

  @Delete('packages/:id/rooms/:roomId') @RequirePermission(P.packageManage)
  removeRoom(@Param('id', uuid()) id: string, @Param('roomId', uuid()) roomId: string, @Req() req: ApiRequest) { return this.packages.removeRoom(actorOf(req), id, roomId); }

  @Post('packages/:id/extras') @RequirePermission(P.packageManage)
  addExtra(@Param('id', uuid()) id: string, @Body(new ZodPipe(createExtraSchema)) b: In<typeof createExtraSchema>, @Req() req: ApiRequest) { return this.packages.addExtra(actorOf(req), id, b); }

  @Patch('packages/:id/extras/:extraId') @RequirePermission(P.packageManage)
  updateExtra(@Param('id', uuid()) id: string, @Param('extraId', uuid()) extraId: string, @Body(new ZodPipe(updateExtraSchema)) b: In<typeof updateExtraSchema>, @Req() req: ApiRequest) { return this.packages.updateExtra(actorOf(req), id, extraId, b); }

  @Delete('packages/:id/extras/:extraId') @RequirePermission(P.packageManage)
  removeExtra(@Param('id', uuid()) id: string, @Param('extraId', uuid()) extraId: string, @Req() req: ApiRequest) { return this.packages.removeExtra(actorOf(req), id, extraId); }

  // ---- Hotels ----
  @Get('hotels') @RequirePermission(P.packageRead)
  listHotels() { return this.packages.listHotels(); }

  @Post('hotels') @RequirePermission(P.hotelManage)
  createHotel(@Body(new ZodPipe(createHotelSchema)) b: In<typeof createHotelSchema>, @Req() req: ApiRequest) { return this.packages.createHotel(actorOf(req), b); }

  @Patch('hotels/:id') @RequirePermission(P.hotelManage)
  updateHotel(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateHotelSchema)) b: In<typeof updateHotelSchema>, @Req() req: ApiRequest) { return this.packages.updateHotel(actorOf(req), id, b); }

  @Delete('hotels/:id') @HttpCode(204) @RequirePermission(P.hotelManage)
  async deleteHotel(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.packages.deleteHotel(actorOf(req), id); }

  // ---- Stock ----
  @Get('editions/:id/pools') @RequirePermission(P.packageRead)
  listPools(@Param('id', uuid()) id: string) { return this.inventory.listForEdition(id); }

  @Post('editions/:id/pools') @RequirePermission(P.inventoryManage)
  createPool(@Param('id', uuid()) id: string, @Body(new ZodPipe(createPoolSchema)) b: In<typeof createPoolSchema>, @Req() req: ApiRequest) { return this.inventory.create(actorOf(req), id, b); }

  @Patch('pools/:id') @RequirePermission(P.inventoryManage)
  updatePool(@Param('id', uuid()) id: string, @Body(new ZodPipe(updatePoolSchema)) b: In<typeof updatePoolSchema>, @Req() req: ApiRequest) { return this.inventory.update(actorOf(req), id, b); }

  @Get('pools/:id/movements') @RequirePermission(P.packageRead)
  movements(@Param('id', uuid()) id: string) { return this.inventory.movements(id); }

  private sendCsv(res: Response, what: string, csv: string): string {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="catalogue-${what}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }
}
