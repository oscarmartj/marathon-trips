import { Module } from '@nestjs/common';
import { HealthController } from './platform/health/health.controller';
import { PlatformModule } from './platform/platform.module';

// Platform pieces load through PlatformModule; business modules are added to modules.registry.ts (see plan 0.1, section 2).
@Module({
  imports: [PlatformModule],
  controllers: [HealthController],
})
export class AppModule {}
