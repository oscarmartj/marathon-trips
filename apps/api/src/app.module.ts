import { Module } from '@nestjs/common';
import { loadConfig } from './platform/config/config';
import { APP_CONFIG, PrismaService } from './platform/database/prisma.service';
import { HealthController } from './platform/health/health.controller';

// Platform pieces load here; business modules are added to modules.registry.ts (see plan 0.1, section 2).
@Module({
  controllers: [HealthController],
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }, PrismaService],
})
export class AppModule {}
