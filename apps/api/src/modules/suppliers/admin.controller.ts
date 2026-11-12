import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  coverageQuerySchema, createAllotmentSchema, createContactSchema, createContractSchema, createCostSchema, createSupplierSchema, costStatusSchema,
  releaseAllotmentSchema, releasesQuerySchema, supplierQuerySchema, updateAllotmentSchema, updateContactSchema, updateContractSchema, updateCostSchema, updateSupplierSchema,
} from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { RequiresModule } from '../../platform/flags/requires-module.guard';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { AllotmentService } from './allotment.service';
import { CostService } from './cost.service';
import { SUPPLIERS_PERMISSIONS as P } from './manifest';
import { SupplierService } from './supplier.service';

const uuid = () => new ParseUUIDPipe();
type In<T extends z.ZodType> = z.infer<T>;

/** The panel's supplier routes. 404 while the `suppliers` module flag is off; every route names one permission. */
@Controller('admin/suppliers')
@RequiresModule('suppliers')
export class SuppliersAdminController {
  constructor(
    @Inject(SupplierService) private readonly suppliers: SupplierService,
    @Inject(AllotmentService) private readonly allotments: AllotmentService,
    @Inject(CostService) private readonly costs: CostService,
  ) {}

  // Fixed paths first, so they are not read as a supplier id.
  @Get('releases') @RequirePermission(P.supplierRead)
  releases(@Query(new ZodPipe(releasesQuerySchema)) q: In<typeof releasesQuerySchema>) { return this.allotments.releases(q); }

  @Get('coverage') @RequirePermission(P.supplierRead)
  coverage(@Query(new ZodPipe(coverageQuerySchema)) q: In<typeof coverageQuerySchema>) { return this.allotments.coverage(q); }

  // ---- Suppliers and contacts ----
  @Get() @RequirePermission(P.supplierRead)
  list(@Query(new ZodPipe(supplierQuerySchema)) q: In<typeof supplierQuerySchema>) { return this.suppliers.list(q); }

  @Post() @RequirePermission(P.supplierManage)
  create(@Body(new ZodPipe(createSupplierSchema)) b: In<typeof createSupplierSchema>, @Req() req: ApiRequest) { return this.suppliers.create(actorOf(req), b); }

  @Get(':id') @RequirePermission(P.supplierRead)
  get(@Param('id', uuid()) id: string) { return this.suppliers.get(id); }

  @Patch(':id') @RequirePermission(P.supplierManage)
  update(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateSupplierSchema)) b: In<typeof updateSupplierSchema>, @Req() req: ApiRequest) { return this.suppliers.update(actorOf(req), id, b); }

  @Delete(':id') @HttpCode(204) @RequirePermission(P.supplierManage)
  async remove(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.suppliers.remove(actorOf(req), id); }

  @Post(':id/contacts') @RequirePermission(P.supplierManage)
  addContact(@Param('id', uuid()) id: string, @Body(new ZodPipe(createContactSchema)) b: In<typeof createContactSchema>, @Req() req: ApiRequest) { return this.suppliers.addContact(actorOf(req), id, b); }

  @Patch('contacts/:id') @RequirePermission(P.supplierManage)
  updateContact(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateContactSchema)) b: In<typeof updateContactSchema>, @Req() req: ApiRequest) { return this.suppliers.updateContact(actorOf(req), id, b); }

  @Delete('contacts/:id') @HttpCode(204) @RequirePermission(P.supplierManage)
  async removeContact(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.suppliers.removeContact(actorOf(req), id); }

  // ---- Contracts ----
  @Get(':id/contracts') @RequirePermission(P.supplierRead)
  listContracts(@Param('id', uuid()) id: string) { return this.suppliers.listContracts(id); }

  @Post(':id/contracts') @RequirePermission(P.supplierManage)
  addContract(@Param('id', uuid()) id: string, @Body(new ZodPipe(createContractSchema)) b: In<typeof createContractSchema>, @Req() req: ApiRequest) { return this.suppliers.addContract(actorOf(req), id, b); }

  @Patch('contracts/:id') @RequirePermission(P.supplierManage)
  updateContract(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateContractSchema)) b: In<typeof updateContractSchema>, @Req() req: ApiRequest) { return this.suppliers.updateContract(actorOf(req), id, b); }

  @Delete('contracts/:id') @HttpCode(204) @RequirePermission(P.supplierManage)
  async removeContract(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.suppliers.removeContract(actorOf(req), id); }

  // ---- Allotments ----
  @Get(':id/allotments') @RequirePermission(P.supplierRead)
  listAllotments(@Param('id', uuid()) id: string) { return this.allotments.listForSupplier(id); }

  @Post('contracts/:id/allotments') @RequirePermission(P.allotmentManage)
  addAllotment(@Param('id', uuid()) id: string, @Body(new ZodPipe(createAllotmentSchema)) b: In<typeof createAllotmentSchema>, @Req() req: ApiRequest) { return this.allotments.create(actorOf(req), id, b); }

  @Patch('allotments/:id') @RequirePermission(P.allotmentManage)
  updateAllotment(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateAllotmentSchema)) b: In<typeof updateAllotmentSchema>, @Req() req: ApiRequest) { return this.allotments.update(actorOf(req), id, b); }

  @Post('allotments/:id/release') @HttpCode(200) @RequirePermission(P.allotmentManage)
  releaseAllotment(@Param('id', uuid()) id: string, @Body(new ZodPipe(releaseAllotmentSchema)) b: In<typeof releaseAllotmentSchema>, @Req() req: ApiRequest) { return this.allotments.release(actorOf(req), id, b); }

  @Delete('allotments/:id') @HttpCode(204) @RequirePermission(P.allotmentManage)
  async removeAllotment(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.allotments.remove(actorOf(req), id); }

  // ---- Cost items ----
  @Get(':id/costs') @RequirePermission(P.costRead)
  listCosts(@Param('id', uuid()) id: string) { return this.costs.listForSupplier(id); }

  @Post(':id/costs') @RequirePermission(P.costManage)
  addCost(@Param('id', uuid()) id: string, @Body(new ZodPipe(createCostSchema)) b: In<typeof createCostSchema>, @Req() req: ApiRequest) { return this.costs.create(actorOf(req), id, b); }

  @Patch('costs/:id') @RequirePermission(P.costManage)
  updateCost(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateCostSchema)) b: In<typeof updateCostSchema>, @Req() req: ApiRequest) { return this.costs.update(actorOf(req), id, b); }

  @Post('costs/:id/status') @HttpCode(200) @RequirePermission(P.costManage)
  costStatus(@Param('id', uuid()) id: string, @Body(new ZodPipe(costStatusSchema)) b: In<typeof costStatusSchema>, @Req() req: ApiRequest) { return this.costs.setStatus(actorOf(req), id, b); }
}
