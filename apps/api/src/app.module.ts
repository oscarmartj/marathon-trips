import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './platform/access/access.guard';
import { AuthModule } from './platform/auth/auth.module';
import { CommonModule } from './platform/common/common.module';
import { IntegrationsModule } from './platform/integrations/integrations.module';
import { RequiresFlagGuard } from './platform/flags/requires-flag.guard';
import { RequiresModuleGuard } from './platform/flags/requires-module.guard';
import { MODULES } from './modules.registry';
import { HealthController } from './platform/health/health.controller';
import { CsrfGuard } from './platform/http/csrf.guard';
import { AuthRateLimitGuard } from './platform/http/rate-limit.guard';
import { MaintenanceGuard } from './platform/http/maintenance.guard';
import { SystemController } from './platform/monitor/system.controller';
import { PlatformModule } from './platform/platform.module';

// Platform pieces load through PlatformModule; business modules are added to modules.registry.ts (see plan 0.1, section 2).
// Global guards run in this order: maintenance mode (503 for everything but health, staff sign-in and the admin API),
// then a switched-off module or flag is a 404 for everyone, then CSRF, then the auth rate
// limit, then access marks (sessions, permissions, step-up).
@Module({
  imports: [PlatformModule, AuthModule, CommonModule, IntegrationsModule, ...MODULES],
  controllers: [HealthController, SystemController],
  providers: [
    { provide: APP_GUARD, useExisting: MaintenanceGuard },
    { provide: APP_GUARD, useExisting: RequiresModuleGuard },
    { provide: APP_GUARD, useExisting: RequiresFlagGuard },
    { provide: APP_GUARD, useExisting: CsrfGuard },
    { provide: APP_GUARD, useExisting: AuthRateLimitGuard },
    { provide: APP_GUARD, useExisting: AccessGuard },
  ],
})
export class AppModule {}
