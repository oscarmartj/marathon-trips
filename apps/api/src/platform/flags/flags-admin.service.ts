import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { PERMISSIONS } from '../access/permissions';
import { AuditActor, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { conflict, notFound } from '../http/api-error';
import { FlagRegistry } from './flag-registry';
import { SettingsService } from './flags.service';

/** Administration of feature flags and settings (plan 4.8): declared in code, changed in the panel, always audited. */
@Injectable()
export class FlagsAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FlagRegistry) private readonly flags: FlagRegistry,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listFlags() {
    const rows = await this.prisma.featureFlag.findMany({ select: { key: true, enabled: true, updatedAt: true } });
    return this.flags.all().map((d) => {
      const row = rows.find((r) => r.key === d.key);
      return { key: d.key, description: d.description, enabled: row?.enabled ?? false, updatedAt: row?.updatedAt.toISOString() ?? null };
    });
  }

  async setFlag(actor: AuditActor, key: string, enabled: boolean, reason?: string): Promise<{ key: string; enabled: boolean }> {
    const def = this.flags.get(key);
    if (!def) throw notFound('flag_unknown', 'Flag not found');
    return this.prisma.$transaction(async (tx) => {
      await tx.featureFlag.upsert({ where: { key }, create: { key, enabled: false, description: def.description }, update: {} });
      const [row] = await tx.$queryRaw<Array<{ id: string; enabled: boolean }>>`SELECT id, enabled FROM feature_flags WHERE key = ${key} FOR UPDATE`;
      if (!row) throw notFound('flag_unknown', 'Flag not found');
      if (row.enabled !== enabled) {
        await tx.featureFlag.update({ where: { key }, data: { enabled } });
        await this.audit.record(tx, { actor, action: 'platform.flag.updated', entityType: 'FeatureFlag', entityId: row.id, reason, before: { enabled: row.enabled }, after: { enabled } });
      }
      return { key, enabled };
    });
  }

  async listSettings() {
    const rows = await this.prisma.setting.findMany({ select: { key: true, value: true, version: true } });
    return this.settings.definitions().map((d) => {
      const row = rows.find((r) => r.key === d.key);
      return { key: d.key, description: d.description, financial: d.financial, value: row?.value ?? null, version: row?.version ?? 0 };
    });
  }

  /** Optimistic lock on `version`; a financial setting also needs platform.setting.manageFinancial with step-up (M12). */
  async setSetting(actor: AuditActor, auth: AuthContext, key: string, input: { value: unknown; version: number; reason?: string }): Promise<{ version: number }> {
    const def = this.settings.definition(key);
    if (!def) throw notFound('setting_unknown', 'Setting not found');
    if (def.financial) await this.access.assertPermission(this.prisma, auth, PERMISSIONS.settingManageFinancial);
    const value = def.schema.parse(input.value) as Prisma.InputJsonValue;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.setting.findUnique({ where: { key }, select: { id: true, value: true, version: true } });
      if ((row?.version ?? 0) !== input.version) throw conflict('version_conflict', 'Someone else changed this setting. Reload and try again.');
      let id: string;
      if (row) {
        const updated = await tx.setting.updateMany({ where: { id: row.id, version: input.version }, data: { value, schemaVersion: def.version, version: { increment: 1 } } });
        if (updated.count !== 1) throw conflict('version_conflict', 'Someone else changed this setting. Reload and try again.');
        id = row.id;
      } else {
        id = (await tx.setting.create({ data: { key, value, schemaVersion: def.version, version: 1 }, select: { id: true } })).id;
      }
      await this.audit.record(tx, { actor, action: 'platform.setting.updated', entityType: 'Setting', entityId: id, reason: input.reason, before: { value: row?.value ?? null }, after: { value } });
      return { version: input.version + 1 };
    });
  }
}
