import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { conflict, forbidden, notFound } from '../http/api-error';
import type { AuthContext } from './auth-context';
import { PermissionRegistry } from './permissions';

type Db = Prisma.TransactionClient | PrismaService;

export const OWNER_ROLE = 'owner';
/** A TOTP check this recent is required for permissions marked requiresStepUp (plan 4.2). */
export const STEP_UP_WINDOW_MS = 5 * 60_000;

export interface Effective {
  isOwner: boolean;
  keys: ReadonlySet<string>;
}

export interface RoleRow {
  scope: unknown;
  role: { key: string; permissions: Array<{ permissionKey: string }> };
}

/**
 * Effective permissions from a user's role rows. `owner` holds every declared permission. A role assigned with a
 * non-null scope grants nothing until scoped access exists (fail closed, plan 4.3). Keys not declared in code are ignored.
 */
export function computeEffective(rows: readonly RoleRow[], declared: ReadonlySet<string>): Effective {
  const live = rows.filter((r) => r.scope === null || r.scope === undefined);
  const isOwner = live.some((r) => r.role.key === OWNER_ROLE);
  if (isOwner) return { isOwner, keys: new Set(declared) };
  const keys = new Set(live.flatMap((r) => r.role.permissions.map((p) => p.permissionKey)).filter((k) => declared.has(k)));
  return { isOwner, keys };
}

@Injectable()
export class AccessService implements OnApplicationBootstrap {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PermissionRegistry) private readonly registry: PermissionRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.syncPermissions();
    await this.ensureSystemRoles();
  }

  /** Declared permissions go to the table. A permission removed from code stays, unused: the guard ignores it. */
  async syncPermissions(): Promise<void> {
    for (const d of this.registry.all()) {
      await this.prisma.permission.upsert({
        where: { key: d.key },
        create: { key: d.key, module: d.module, description: d.description, requiresStepUp: d.requiresStepUp ?? false },
        update: { module: d.module, description: d.description, requiresStepUp: d.requiresStepUp ?? false },
      });
    }
  }

  async ensureSystemRoles(): Promise<void> {
    await this.prisma.role.upsert({
      where: { key: OWNER_ROLE },
      create: { key: OWNER_ROLE, name: 'Owner', description: 'Every permission. Cannot be edited.', isSystem: true },
      update: {},
    });
  }

  declaredKeys(): ReadonlySet<string> {
    return new Set(this.registry.all().map((d) => d.key));
  }

  async effective(db: Db, userId: string): Promise<Effective> {
    const rows = await db.userRole.findMany({
      where: { userId, user: { kind: 'staff', status: 'active' } },
      select: { scope: true, role: { select: { key: true, permissions: { select: { permissionKey: true } } } } },
    });
    return computeEffective(rows, this.declaredKeys());
  }

  /**
   * The check AccessGuard runs for @RequirePermission, also used by services for a second, finer permission (M12):
   * staff only, the permission held, and a recent TOTP check when the permission requires step-up.
   */
  async assertPermission(db: Db, auth: AuthContext | undefined, key: string, now: Date = new Date()): Promise<Effective> {
    const def = this.registry.get(key);
    if (!def) throw forbidden('permission_not_declared', 'This action is not available');
    if (!auth || auth.kind !== 'staff') throw forbidden();
    const eff = await this.effective(db, auth.userId);
    if (!eff.keys.has(key)) throw forbidden();
    if (def.requiresStepUp && !(auth.mfaVerifiedAt && now.getTime() - auth.mfaVerifiedAt.getTime() <= STEP_UP_WINDOW_MS)) {
      throw forbidden('step_up_required', 'Confirm with your authenticator code to continue');
    }
    return eff;
  }

  /**
   * G1: an actor may only act on another staff account whose permissions are all within the actor's own, and only an
   * owner acts on an owner. Never on oneself. Locks the target user row first.
   */
  async assertCanActOn(tx: Prisma.TransactionClient, actorUserId: string, targetUserId: string): Promise<{ actor: Effective; target: Effective }> {
    if (actorUserId === targetUserId) throw forbidden('cannot_act_on_self', 'You cannot do this to your own account');
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${targetUserId}::uuid AND kind = 'staff' FOR UPDATE`;
    if (locked.length === 0) throw notFound();
    const actor = await this.effective(tx, actorUserId);
    const rows = await tx.userRole.findMany({
      where: { userId: targetUserId },
      select: { scope: true, role: { select: { key: true, permissions: { select: { permissionKey: true } } } } },
    });
    const target = computeEffective(rows, this.declaredKeys());
    if (target.isOwner && !actor.isOwner) throw forbidden('target_is_owner', 'Only an owner can do this to an owner');
    for (const k of target.keys) if (!actor.keys.has(k)) throw forbidden('target_has_more_permissions', 'This account has permissions you do not have');
    return { actor, target };
  }

  /** G1, T9: an actor can only grant or remove roles whose permissions it holds; only an owner touches the owner role. */
  async assertCanHandleRoles(tx: Prisma.TransactionClient, actor: Effective, roleIds: readonly string[]): Promise<void> {
    if (roleIds.length === 0) return;
    const roles = await tx.role.findMany({ where: { id: { in: [...roleIds] } }, select: { id: true, key: true, permissions: { select: { permissionKey: true } } } });
    if (roles.length !== new Set(roleIds).size) throw notFound('role_not_found', 'Role not found');
    for (const r of roles) {
      if (r.key === OWNER_ROLE && !actor.isOwner) throw forbidden('only_owner_assigns_owner', 'Only an owner can assign or remove the owner role');
      for (const p of r.permissions) {
        if (this.registry.get(p.permissionKey) && !actor.keys.has(p.permissionKey)) throw forbidden('role_has_more_permissions', 'This role has permissions you do not have');
      }
    }
  }

  /**
   * T10: before an owner loses the role or is disabled, lock the owner role row (serialising every such change) and
   * make sure another active owner remains.
   */
  async assertAnotherOwnerRemains(tx: Prisma.TransactionClient, leavingUserId: string): Promise<void> {
    const role = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM roles WHERE key = ${OWNER_ROLE} FOR UPDATE`;
    if (role.length === 0) return;
    const remaining = await tx.userRole.count({
      where: { roleId: role[0]!.id, userId: { not: leavingUserId }, user: { status: 'active' } },
    });
    if (remaining === 0) throw conflict('last_owner', 'There must always be at least one active owner');
  }

  async isOwner(db: Db, userId: string): Promise<boolean> {
    return (await this.effective(db, userId)).isOwner;
  }
}
