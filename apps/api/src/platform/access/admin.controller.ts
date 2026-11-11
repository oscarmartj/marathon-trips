import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  auditQuerySchema, createRoleSchema, createStaffSchema, setFlagSchema, setRolePermissionsSchema, setSettingSchema, setStaffRolesSchema,
  staffActionSchema,
} from '@mt/shared';
import { AuditReadService } from '../audit/audit-read.service';
import { FlagsAdminService } from '../flags/flags-admin.service';
import type { ApiRequest } from '../http/request-context';
import { ZodPipe } from '../http/zod.pipe';
import { RequirePermission } from './access.decorators';
import { actorOf } from './actor';
import { PERMISSIONS } from './permissions';
import { RolesAdminService } from './roles-admin.service';
import { StaffAdminService } from './staff-admin.service';

type Reason = { reason?: string };

/** Staff, roles, audit, flags and settings in the panel. Every route needs a permission (step-up where it says so). */
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(StaffAdminService) private readonly staff: StaffAdminService,
    @Inject(RolesAdminService) private readonly roles: RolesAdminService,
    @Inject(AuditReadService) private readonly auditRead: AuditReadService,
    @Inject(FlagsAdminService) private readonly flags: FlagsAdminService,
  ) {}

  @Get('staff')
  @RequirePermission(PERMISSIONS.userRead)
  listStaff() {
    return this.staff.list();
  }

  /** The set-up link is in this response only; it is never stored or shown again. */
  @Post('staff')
  @RequirePermission(PERMISSIONS.userManage)
  createStaff(@Body(new ZodPipe(createStaffSchema)) body: { email: string; roleKeys: string[] } & Reason, @Req() req: ApiRequest) {
    return this.staff.create(actorOf(req), body);
  }

  @Patch('staff/:id/roles')
  @RequirePermission(PERMISSIONS.userManage)
  async setStaffRoles(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(setStaffRolesSchema)) body: { roleKeys: string[]; scope?: unknown } & Reason, @Req() req: ApiRequest) {
    await this.staff.setRoles(actorOf(req), id, body);
    return this.staff.get(id);
  }

  @Post('staff/:id/disable')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.userManage)
  async disableStaff(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(staffActionSchema)) body: Reason, @Req() req: ApiRequest) {
    await this.staff.setStatus(actorOf(req), id, 'disabled', body.reason);
    return this.staff.get(id);
  }

  @Post('staff/:id/enable')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.userManage)
  async enableStaff(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(staffActionSchema)) body: Reason, @Req() req: ApiRequest) {
    await this.staff.setStatus(actorOf(req), id, 'active', body.reason);
    return this.staff.get(id);
  }

  /** Revokes sessions and credentials and returns a new set-up link, once. */
  @Post('staff/:id/reset-enrolment')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.userManage)
  resetStaff(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(staffActionSchema)) body: Reason, @Req() req: ApiRequest) {
    return this.staff.resetEnrolment(actorOf(req), id, body.reason);
  }

  @Get('permissions')
  @RequirePermission(PERMISSIONS.roleRead)
  listPermissions() {
    return this.roles.permissions();
  }

  @Get('roles')
  @RequirePermission(PERMISSIONS.roleRead)
  listRoles() {
    return this.roles.list();
  }

  @Post('roles')
  @RequirePermission(PERMISSIONS.roleManage)
  createRole(@Body(new ZodPipe(createRoleSchema)) body: { key: string; name: string; description: string } & Reason, @Req() req: ApiRequest) {
    return this.roles.create(actorOf(req), body);
  }

  @Put('roles/:key/permissions')
  @RequirePermission(PERMISSIONS.roleManage)
  setRolePermissions(@Param('key') key: string, @Body(new ZodPipe(setRolePermissionsSchema)) body: { permissionKeys: string[]; version: number } & Reason, @Req() req: ApiRequest) {
    return this.roles.setPermissions(actorOf(req), key, body);
  }

  @Get('audit')
  @RequirePermission(PERMISSIONS.auditRead)
  history(@Query(new ZodPipe(auditQuerySchema)) q: { entityType: string; entityId: string }) {
    return this.auditRead.history(q.entityType, q.entityId);
  }

  @Get('flags')
  @RequirePermission(PERMISSIONS.flagRead)
  listFlags() {
    return this.flags.listFlags();
  }

  @Put('flags/:key')
  @RequirePermission(PERMISSIONS.flagManage)
  setFlag(@Param('key') key: string, @Body(new ZodPipe(setFlagSchema)) body: { enabled: boolean } & Reason, @Req() req: ApiRequest) {
    return this.flags.setFlag(actorOf(req), key, body.enabled, body.reason);
  }

  @Get('settings')
  @RequirePermission(PERMISSIONS.settingRead)
  listSettings() {
    return this.flags.listSettings();
  }

  @Put('settings/:key')
  @RequirePermission(PERMISSIONS.settingManage)
  setSetting(@Param('key') key: string, @Body(new ZodPipe(setSettingSchema)) body: { value: unknown; version: number } & Reason, @Req() req: ApiRequest) {
    return this.flags.setSetting(actorOf(req), req.auth!, key, body);
  }
}
