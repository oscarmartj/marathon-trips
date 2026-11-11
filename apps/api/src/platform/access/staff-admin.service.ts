import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditActor, AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { StaffAuthService } from '../auth/staff-auth.service';
import { PrismaService } from '../database/prisma.service';
import { OutboxService } from '../events/outbox.service';
import { conflict, notFound, unprocessable } from '../http/api-error';
import { AccessService, OWNER_ROLE } from './access.service';

const ROLE_KEYS_CLASS = { roleKeys: 'nopii' } as const;

export interface StaffView {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  enrolled: boolean;
  roleKeys: string[];
  lastLoginAt: string | null;
  version: number;
}

/** Staff accounts in the panel (G1, T9, T10). Every change is audited in its own transaction. */
@Injectable()
export class StaffAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(StaffAuthService) private readonly staffAuth: StaffAuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(): Promise<StaffView[]> {
    const users = await this.prisma.user.findMany({
      where: { kind: 'staff' },
      orderBy: { email: 'asc' },
      select: { id: true, email: true, status: true, totpEnabledAt: true, lastLoginAt: true, version: true, roles: { select: { role: { select: { key: true } } } } },
    });
    return users.map((u) => ({
      id: u.id, email: u.email, status: u.status, enrolled: !!u.totpEnabledAt, roleKeys: u.roles.map((r) => r.role.key).sort(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null, version: u.version,
    }));
  }

  private async rolesByKey(tx: Prisma.TransactionClient, keys: readonly string[]) {
    const roles = await tx.role.findMany({ where: { key: { in: [...keys] } }, select: { id: true, key: true } });
    if (roles.length !== new Set(keys).size) throw unprocessable('role_not_found', 'One of the roles does not exist');
    return roles;
  }

  private async roleChanged(tx: Prisma.TransactionClient, actor: AuditActor, userId: string): Promise<void> {
    await this.outbox.publish(tx, { type: 'access.role.changed', aggregateType: 'User', aggregateId: userId, actorType: 'staff', actorId: actor.id ?? undefined, payload: { userId } });
  }

  async create(actor: AuditActor & { id: string }, input: { email: string; roleKeys: string[]; reason?: string }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const actorEff = await this.access.effective(tx, actor.id);
        const roles = await this.rolesByKey(tx, input.roleKeys);
        await this.access.assertCanHandleRoles(tx, actorEff, roles.map((r) => r.id));
        const user = await tx.user.create({ data: { kind: 'staff', email: input.email }, select: { id: true, email: true, kind: true, status: true } });
        if (roles.length > 0) await tx.userRole.createMany({ data: roles.map((r) => ({ userId: user.id, roleId: r.id, createdById: actor.id })) });
        await this.audit.record(tx, {
          actor, action: 'access.user.created', entityType: 'User', entityId: user.id, reason: input.reason, fieldClasses: ROLE_KEYS_CLASS,
          after: { kind: user.kind, status: user.status, email: user.email, roleKeys: roles.map((r) => r.key).sort() },
        });
        if (roles.length > 0) await this.roleChanged(tx, actor, user.id);
        const enrolment = await this.staffAuth.issueEnrolment(tx, user.id, user.email);
        return { id: user.id, enrolmentUrl: enrolment.url, enrolmentExpiresAt: enrolment.expiresAt.toISOString() };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('email_taken', 'A staff account with this email already exists');
      throw e;
    }
  }

  async setRoles(actor: AuditActor & { id: string }, targetId: string, input: { roleKeys: string[]; scope?: unknown; reason?: string }): Promise<void> {
    if (input.scope !== undefined && input.scope !== null) throw unprocessable('role_scope_not_supported', 'Scoped roles are not available yet');
    await this.prisma.$transaction(async (tx) => {
      const { actor: actorEff } = await this.access.assertCanActOn(tx, actor.id, targetId);
      const current = await tx.userRole.findMany({ where: { userId: targetId }, select: { roleId: true, role: { select: { key: true } } } });
      const wanted = await this.rolesByKey(tx, input.roleKeys);
      const added = wanted.filter((w) => !current.some((c) => c.roleId === w.id));
      const removed = current.filter((c) => !wanted.some((w) => w.id === c.roleId));
      if (added.length === 0 && removed.length === 0) return;
      await this.access.assertCanHandleRoles(tx, actorEff, [...added.map((r) => r.id), ...removed.map((r) => r.roleId)]);
      if (removed.some((r) => r.role.key === OWNER_ROLE)) await this.access.assertAnotherOwnerRemains(tx, targetId);
      if (removed.length > 0) await tx.userRole.deleteMany({ where: { userId: targetId, roleId: { in: removed.map((r) => r.roleId) } } });
      if (added.length > 0) await tx.userRole.createMany({ data: added.map((r) => ({ userId: targetId, roleId: r.id, createdById: actor.id })) });
      await tx.user.update({ where: { id: targetId }, data: { version: { increment: 1 } } });
      await this.audit.record(tx, {
        actor, action: 'access.user.rolesChanged', entityType: 'User', entityId: targetId, reason: input.reason, fieldClasses: ROLE_KEYS_CLASS,
        before: { roleKeys: current.map((c) => c.role.key).sort() }, after: { roleKeys: wanted.map((w) => w.key).sort() },
      });
      await this.roleChanged(tx, actor, targetId);
    });
  }

  async setStatus(actor: AuditActor & { id: string }, targetId: string, status: 'active' | 'disabled', reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { target } = await this.access.assertCanActOn(tx, actor.id, targetId);
      const before = await tx.user.findUniqueOrThrow({ where: { id: targetId }, select: { status: true } });
      if (before.status === status) return;
      if (status === 'disabled' && target.isOwner) await this.access.assertAnotherOwnerRemains(tx, targetId);
      await tx.user.update({ where: { id: targetId }, data: { status, version: { increment: 1 } } });
      if (status === 'disabled') await this.sessions.revokeAllForUser(tx, targetId, 'user_disabled');
      await this.audit.record(tx, { actor, action: status === 'disabled' ? 'access.user.disabled' : 'access.user.enabled', entityType: 'User', entityId: targetId, reason, before, after: { status } });
    });
  }

  async resetEnrolment(actor: AuditActor & { id: string }, targetId: string, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.access.assertCanActOn(tx, actor.id, targetId);
      const r = await this.staffAuth.resetCredentials(tx, targetId, actor, reason);
      return { enrolmentUrl: r.url, enrolmentExpiresAt: r.expiresAt.toISOString() };
    });
  }

  async get(id: string): Promise<StaffView> {
    const found = (await this.list()).find((u) => u.id === id);
    if (!found) throw notFound();
    return found;
  }
}
