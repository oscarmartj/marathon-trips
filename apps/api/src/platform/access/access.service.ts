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

  /** `effective` for many users in one query. A user who is not active staff has no entry in the answer's keys (empty set). */
  async effectiveMany(db: Db, userIds: readonly string[]): Promise<Map<string, Effective>> {
    const rows = await db.userRole.findMany({
      where: { userId: { in: [...userIds] }, user: { kind: 'staff', status: 'active' } },
      select: { userId: true, scope: true, role: { select: { key: true, permissions: { select: { permissionKey: true } } } } },
    });
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
    const declared = this.declaredKeys();
    return new Map(userIds.map((id) => [id, computeEffective(byUser.get(id) ?? [], declared)]));
  }

  /**
   * What this request may do. For a session: the user's permissions. For an API key (task 8.4): the owner's current
   * permissions intersected with the key's scopes, keeping only API-key-scopable permissions, and never owner status.
   */
  async effectiveFor(db: Db, auth: AuthContext): Promise<Effective> {
    const eff = await this.effective(db, auth.userId);
    if (auth.via !== 'api_key') return eff;
    const keys = [...eff.keys].filter((k) => {
      const def = this.registry.get(k);
      return !!def && auth.scopes.has(k) && def.apiKeyScopable === true && !def.requiresStepUp;
    });
    return { isOwner: false, keys: new Set(keys) };
  }

  /**
   * The check AccessGuard runs for @RequirePermission, also used by services for a second, finer permission (M12):
   * staff only, the permission held, and a recent TOTP check when the permission requires step-up. An API key also
   * needs the permission in its scopes and API-key scopable, and never passes a step-up permission.
   */
  async assertPermission(db: Db, auth: AuthContext | undefined, key: string, now: Date = new Date()): Promise<Effective> {
    const def = this.registry.get(key);
    if (!def) throw forbidden('permission_not_declared', 'This action is not available');
    if (!auth || auth.kind !== 'staff') throw forbidden();
    if (auth.via === 'api_key') {
      if (def.requiresStepUp) throw forbidden('api_key_cannot_use_step_up_permission', 'An API key cannot do this; sign in to the panel');
      if (!def.apiKeyScopable || !auth.scopes.has(key)) throw forbidden('api_key_scope_not_allowed', 'This API key does not allow this action');
    }
    const eff = await this.effectiveFor(db, auth);
    if (!eff.keys.has(key)) throw forbidden();
    if (def.requiresStepUp && !(auth.mfaVerifiedAt && now.getTime() - auth.mfaVerifiedAt.getTime() <= STEP_UP_WINDOW_MS)) {
      throw forbidden('step_up_required', 'Confirm with your authenticator code to continue');
    }
    return eff;
  }

  /**
   * Locks staff user rows in one order (by id) so concurrent admin changes never deadlock; user rows are always locked
   * before the owner role row (assertAnotherOwnerRemains).
   */
  async lockUsers(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids)].sort();
    if (unique.length === 0) return [];
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ANY(${unique}::uuid[]) ORDER BY id FOR UPDATE`;
    return rows.map((r) => r.id);
  }

  /** Under the actor's lock: the actor is still active staff and still holds `key` (it may have changed since the guard). */
  async lockedActor(tx: Prisma.TransactionClient, actorUserId: string, key: string): Promise<Effective> {
    const actor = await this.effective(tx, actorUserId);
    if (!actor.keys.has(key)) throw forbidden();
    return actor;
  }

  /**
   * G1: an actor may only act on another staff account whose permissions are all within the actor's own, and only an
   * owner acts on an owner. Never on oneself. Locks actor and target (in id order) and re-reads both under the lock.
   */
  async assertCanActOn(tx: Prisma.TransactionClient, actorUserId: string, targetUserId: string, key: string): Promise<{ actor: Effective; target: Effective }> {
    if (actorUserId === targetUserId) throw forbidden('cannot_act_on_self', 'You cannot do this to your own account');
    const locked = await this.lockUsers(tx, [actorUserId, targetUserId]);
    const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { kind: true } });
    if (!locked.includes(targetUserId) || target?.kind !== 'staff') throw notFound();
    const actor = await this.lockedActor(tx, actorUserId, key);
    const targetEff = await this.rolesEffective(tx, targetUserId);
    this.assertCovers(actor, targetEff, 'target');
    return { actor, target: targetEff };
  }

  /** Effective permissions from role rows, whatever the user's status (for targets and role holders). */
  async rolesEffective(tx: Prisma.TransactionClient, userId: string): Promise<Effective> {
    const rows = await tx.userRole.findMany({
      where: { userId },
      select: { scope: true, role: { select: { key: true, permissions: { select: { permissionKey: true } } } } },
    });
    return computeEffective(rows, this.declaredKeys());
  }

  private assertCovers(actor: Effective, other: Effective, who: 'target' | 'holder'): void {
    if (other.isOwner && !actor.isOwner) {
      throw who === 'target' ? forbidden('target_is_owner', 'Only an owner can do this to an owner') : forbidden('role_holder_is_owner', 'An owner holds this role');
    }
    for (const k of other.keys) {
      if (!actor.keys.has(k)) {
        throw who === 'target'
          ? forbidden('target_has_more_permissions', 'This account has permissions you do not have')
          : forbidden('role_holder_has_more_permissions', 'Someone with this role has permissions you do not have');
      }
    }
  }

  /**
   * G1 for a shared role (point 6 of the code review): a non-owner may change a role only if every user holding it has
   * nothing beyond the actor's own permissions. Locks the actor and the holders in id order.
   */
  async assertCanEditRole(tx: Prisma.TransactionClient, actorUserId: string, roleId: string, key: string): Promise<Effective> {
    const holders = await tx.userRole.findMany({ where: { roleId }, select: { userId: true } });
    await this.lockUsers(tx, [actorUserId, ...holders.map((h) => h.userId)]);
    const actor = await this.lockedActor(tx, actorUserId, key);
    if (actor.isOwner) return actor;
    const again = await tx.userRole.findMany({ where: { roleId }, select: { userId: true } });
    for (const h of again) if (h.userId !== actorUserId) this.assertCovers(actor, await this.rolesEffective(tx, h.userId), 'holder');
    return actor;
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
