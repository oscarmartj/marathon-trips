import { Injectable } from '@nestjs/common';
import { AppError } from '../errors/safe-error';

export interface PermissionDef {
  /** <module>.<resource>.<action> (plan 1.5). */
  key: string;
  module: string;
  description: string;
  /** A TOTP check in the last 5 minutes is required to use it (plan 4.2, 4.3). */
  requiresStepUp?: boolean;
}

const KEY = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;

export const PERMISSIONS = {
  roleRead: 'access.role.read',
  roleManage: 'access.role.manage',
  userRead: 'access.user.read',
  userManage: 'access.user.manage',
  auditRead: 'audit.log.read',
  flagRead: 'platform.flag.read',
  flagManage: 'platform.flag.manage',
  settingRead: 'platform.setting.read',
  settingManage: 'platform.setting.manage',
  settingManageFinancial: 'platform.setting.manageFinancial',
} as const;

/** The platform's own permissions (task 0.3). Business modules declare theirs in their manifest. */
export const PLATFORM_PERMISSIONS: readonly PermissionDef[] = [
  { key: PERMISSIONS.roleRead, module: 'access', description: 'See roles and their permissions' },
  { key: PERMISSIONS.roleManage, module: 'access', description: 'Create roles and change their permissions', requiresStepUp: true },
  { key: PERMISSIONS.userRead, module: 'access', description: 'See staff accounts and their roles' },
  { key: PERMISSIONS.userManage, module: 'access', description: 'Create, disable, reset and assign roles to staff accounts', requiresStepUp: true },
  { key: PERMISSIONS.auditRead, module: 'audit', description: 'Read the audit log (without personal values)' },
  { key: PERMISSIONS.flagRead, module: 'platform', description: 'See feature flags' },
  { key: PERMISSIONS.flagManage, module: 'platform', description: 'Switch feature flags on and off' },
  { key: PERMISSIONS.settingRead, module: 'platform', description: 'See business settings' },
  { key: PERMISSIONS.settingManage, module: 'platform', description: 'Change business settings' },
  { key: PERMISSIONS.settingManageFinancial, module: 'platform', description: 'Change settings that affect money (currency, GST)', requiresStepUp: true },
];

/** Every permission declared in code; synchronised to the Permission table at start-up. */
@Injectable()
export class PermissionRegistry {
  private readonly defs = new Map<string, PermissionDef>();

  constructor() {
    this.register(PLATFORM_PERMISSIONS);
  }

  register(defs: readonly PermissionDef[]): void {
    for (const d of defs) {
      if (!KEY.test(d.key)) throw new AppError('permission_bad_key', `Permission ${d.key} must be <module>.<resource>.<action>`);
      if (this.defs.has(d.key)) throw new AppError('permission_duplicate', `Permission ${d.key} is declared twice`);
      this.defs.set(d.key, { ...d, requiresStepUp: d.requiresStepUp ?? false });
    }
  }

  get(key: string): PermissionDef | undefined {
    return this.defs.get(key);
  }

  all(): PermissionDef[] {
    return [...this.defs.values()];
  }
}
