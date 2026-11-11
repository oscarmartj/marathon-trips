import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@mt/shared';
import { AppConfig } from '../config/config';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    // Explicit tokens: tsx (pnpm dev) does not emit decorator metadata, so never rely on type-based injection.
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    let database: HealthResponse['database'] = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    return { status: database === 'up' ? 'ok' : 'degraded', appEnv: this.config.APP_ENV, database };
  }
}
