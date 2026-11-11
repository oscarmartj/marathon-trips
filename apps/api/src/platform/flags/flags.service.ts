import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import { AppError } from '../errors/safe-error';
import { PrismaService } from '../database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** Modules without a feature flag: they cannot be switched off (plan 3.1). */
export const ALWAYS_ON_MODULES: ReadonlySet<string> = new Set(['platform', 'catalogue', 'pricing', 'bookings', 'payments']);

export const moduleFlagKey = (module: string): string => `module.${module}`;

/**
 * Reads feature flags on every call, so a change takes effect without a restart (plan 3.1). A missing row means
 * "off": the conservative answer. Administration (HTTP, audit) is task 0.3.
 */
@Injectable()
export class FeatureFlagService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async isEnabled(key: string, db: Db = this.prisma): Promise<boolean> {
    const row = await db.featureFlag.findUnique({ where: { key }, select: { enabled: true } });
    return row?.enabled ?? false;
  }

  async isModuleEnabled(module: string, db: Db = this.prisma): Promise<boolean> {
    return ALWAYS_ON_MODULES.has(module) || this.isEnabled(moduleFlagKey(module), db);
  }

  /** Creates the flag if it does not exist, never changes an existing value. For seeds and module set-up. */
  async ensure(key: string, enabled: boolean, description = '', db: Db = this.prisma): Promise<void> {
    await db.featureFlag.upsert({ where: { key }, create: { key, enabled, description }, update: {} });
  }
}

/** A setting's value is validated by a schema registered in code; unknown keys are rejected. */
@Injectable()
export class SettingsService {
  private readonly schemas = new Map<string, { schema: z.ZodType; version: number; financial: boolean; description: string }>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * `financial` settings (currency, GST) can only be changed with platform.setting.manageFinancial, which requires
   * step-up (task 0.3, M12).
   */
  define(key: string, schema: z.ZodType, version = 1, opts: { financial?: boolean; description?: string } = {}): void {
    if (this.schemas.has(key)) throw new AppError('setting_already_defined', `Setting ${key} is already defined`);
    this.schemas.set(key, { schema, version, financial: opts.financial ?? false, description: opts.description ?? '' });
  }

  /** Definitions in code, for the admin API. */
  definitions(): Array<{ key: string; schema: z.ZodType; version: number; financial: boolean; description: string }> {
    return [...this.schemas.entries()].map(([key, d]) => ({ key, ...d }));
  }

  definition(key: string) {
    return this.schemas.get(key);
  }

  private def(key: string) {
    const d = this.schemas.get(key);
    if (!d) throw new AppError('setting_unknown', `Setting ${key} is not defined in code`);
    return d;
  }

  async get<T>(key: string, fallback: T): Promise<T> {
    const d = this.def(key);
    const row = await this.prisma.setting.findUnique({ where: { key } });
    if (!row) return fallback;
    return d.schema.parse(row.value) as T;
  }

  async set(key: string, value: unknown, db: Db = this.prisma): Promise<void> {
    const d = this.def(key);
    const parsed = d.schema.parse(value) as Prisma.InputJsonValue;
    await db.setting.upsert({
      where: { key },
      create: { key, value: parsed, schemaVersion: d.version },
      update: { value: parsed, schemaVersion: d.version },
    });
  }
}
