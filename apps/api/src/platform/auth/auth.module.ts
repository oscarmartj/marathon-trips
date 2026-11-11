import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { AccessService } from '../access/access.service';
import { AdminController } from '../access/admin.controller';
import { RolesAdminService } from '../access/roles-admin.service';
import { StaffAdminService } from '../access/staff-admin.service';
import { AuditReadService } from '../audit/audit-read.service';
import { AuditService } from '../audit/audit.service';
import type { AppConfig } from '../config/config';
import { SecretBox } from '../crypto/secret-box';
import { APP_CONFIG } from '../database/prisma.service';
import { FlagsAdminService } from '../flags/flags-admin.service';
import { registerAuthAuditSubjects } from './audit-subjects';
import { AuthMaintenanceService } from './auth-maintenance.service';
import { AuthController } from './auth.controller';
import { CustomerAuthService } from './customer-auth.service';
import { SessionService } from './session.service';
import { SECRET_BOX, StaffAuthService } from './staff-auth.service';

/** Task 0.3: sign-in, sessions, staff and roles administration, audit history, flags and settings administration. */
@Module({
  controllers: [AuthController, AdminController],
  providers: [
    { provide: SECRET_BOX, useFactory: (c: AppConfig) => new SecretBox(c.APP_ENCRYPTION_KEY, c.APP_ENCRYPTION_KEY_VERSION), inject: [APP_CONFIG] },
    StaffAuthService, CustomerAuthService, StaffAdminService, RolesAdminService, AuditReadService, FlagsAdminService, AuthMaintenanceService,
  ],
  exports: [SECRET_BOX, StaffAuthService, CustomerAuthService, StaffAdminService, RolesAdminService, AuthMaintenanceService],
})
export class AuthModule implements OnModuleInit {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  onModuleInit(): void {
    registerAuthAuditSubjects(this.audit);
  }
}
