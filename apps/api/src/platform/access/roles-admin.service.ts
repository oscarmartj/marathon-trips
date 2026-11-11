import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditActor, AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { OutboxService } from '../events/outbox.service';
import { conflict, forbidden, notFound, unprocessable } from '../http/api-error';
import { AccessService, OWNER_ROLE } from './access.service';
import { PERMISSIONS, PermissionRegistry } from './permissions';

const PERMISSION_KEYS_CLASS = { permissionKeys: 'nopii' } as const;

/** Roles and the permission matrix (plan 4.3). The owner role is not editable; nobody grants what they do not hold. */
@Injectable()
export class RolesAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(PermissionRegistry) private readonly registry: PermissionRegistry,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  permissions() {
    return this.registry.all().map((p) => ({ key: p.key, module: p.module, description: p.description, requiresStepUp: p.requiresStepUp ?? false }));
  }

  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
      select: { id: true, key: true, name: true, description: true, isSystem: true, version: true, permissions: { select: { permissionKey: true } }, _count: { select: { users: true } } },
    });
    const all = this.registry.all().map((p) => p.key).sort();
    return roles.map((r) => ({
      id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem, version: r.version, memberCount: r._count.users,
      permissionKeys: r.key === OWNER_ROLE ? all : r.permissions.map((p) => p.permissionKey).filter((k) => this.registry.get(k)).sort(),
    }));
  }

  async create(actor: AuditActor, input: { key: string; name: string; description: string; reason?: string }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.create({ data: { key: input.key, name: input.name, description: input.description }, select: { id: true, key: true, name: true, description: true } });
        await this.audit.record(tx, { actor, action: 'access.role.created', entityType: 'Role', entityId: role.id, reason: input.reason, after: { key: role.key, name: role.name, description: role.description } });
        return { id: role.id };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('role_key_taken', 'A role with this key already exists');
      throw e;
    }
  }

  async setPermissions(actor: AuditActor & { id: string }, roleKey: string, input: { permissionKeys: string[]; version: number; reason?: string }): Promise<{ version: number }> {
    const wanted = [...new Set(input.permissionKeys)].sort();
    const unknown = wanted.filter((k) => !this.registry.get(k));
    if (unknown.length > 0) throw unprocessable('permission_unknown', 'One of the permissions does not exist');
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { key: roleKey }, select: { id: true, key: true, isSystem: true, version: true, permissions: { select: { permissionKey: true } } } });
      if (!role) throw notFound('role_not_found', 'Role not found');
      if (role.isSystem || role.key === OWNER_ROLE) throw conflict('role_not_editable', 'This role cannot be edited');
      const current = role.permissions.map((p) => p.permissionKey).sort();
      const added = wanted.filter((k) => !current.includes(k));
      const removed = current.filter((k) => !wanted.includes(k));
      const actorEff = await this.access.assertCanEditRole(tx, actor.id, role.id, PERMISSIONS.roleManage);
      // T9: you can only hand out, or take away, what you hold yourself.
      for (const k of [...added, ...removed]) if (this.registry.get(k) && !actorEff.keys.has(k)) throw forbidden('cannot_grant_permission_actor_lacks', 'You can only change permissions you have');
      const bumped = await tx.role.updateMany({ where: { id: role.id, version: input.version }, data: { version: { increment: 1 } } });
      if (bumped.count !== 1) throw conflict('version_conflict', 'Someone else changed this role. Reload and try again.');
      if (removed.length > 0) await tx.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: { in: removed } } });
      if (added.length > 0) await tx.rolePermission.createMany({ data: added.map((k) => ({ roleId: role.id, permissionKey: k })) });
      await this.audit.record(tx, {
        actor, action: 'access.role.permissionsChanged', entityType: 'Role', entityId: role.id, reason: input.reason, fieldClasses: PERMISSION_KEYS_CLASS,
        before: { permissionKeys: current }, after: { permissionKeys: wanted },
      });
      await this.outbox.publish(tx, { type: 'access.role.changed', aggregateType: 'Role', aggregateId: role.id, actorType: 'staff', actorId: actor.id, payload: { roleId: role.id } });
      return { version: role.version + 1 };
    });
  }
}
