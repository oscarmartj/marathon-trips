import { Inject, Injectable } from '@nestjs/common';
import type { CreateApiKeyInput } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { PermissionRegistry } from '../access/permissions';
import { AuditActor, AuditService } from '../audit/audit.service';
import type { AppConfig } from '../config/config';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { conflict, notFound, unprocessable } from '../http/api-error';
import { apiKeySecretHash, newApiKeyToken } from './api-key-token';
import { INTEGRATIONS_PERMISSIONS } from './permissions';

export const MAX_ACTIVE_KEYS_PER_OWNER = 10;
const DAY_MS = 24 * 3600_000;

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  ownerUserId: string;
  mine: boolean;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
}

/** API key administration (task 8.4, plan 3.5 and 11). The token is in the create response only, never again. */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(PermissionRegistry) private readonly registry: PermissionRegistry,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, now: Date = new Date()): Promise<ApiKeyView[]> {
    const rows = await this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, prefix: true, scopes: true, ownerUserId: true, expiresAt: true, lastUsedAt: true, revokedAt: true, revokeReason: true, createdAt: true },
    });
    return rows.map((r) => ({
      id: r.id, name: r.name, prefix: r.prefix, scopes: [...r.scopes].sort(), ownerUserId: r.ownerUserId, mine: r.ownerUserId === auth.userId,
      status: r.revokedAt ? 'revoked' : r.expiresAt <= now ? 'expired' : 'active',
      expiresAt: r.expiresAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null, revokedAt: r.revokedAt?.toISOString() ?? null,
      revokeReason: r.revokeReason, createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Permissions the caller could give a new key: API-key scopable, no step-up, and held by the caller now. */
  async scopable(auth: AuthContext): Promise<Array<{ key: string; description: string }>> {
    const eff = await this.access.effectiveFor(this.prisma, auth);
    return this.registry.all().filter((d) => d.apiKeyScopable && !d.requiresStepUp && eff.keys.has(d.key))
      .map((d) => ({ key: d.key, description: d.description })).sort((a, b) => a.key.localeCompare(b.key));
  }

  async create(actor: AuditActor & { id: string }, auth: AuthContext, input: CreateApiKeyInput, now: Date = new Date()) {
    for (const s of input.scopes) {
      const def = this.registry.get(s);
      if (!def) throw unprocessable('unknown_scope', 'One of the scopes is not a permission');
      if (def.requiresStepUp) throw unprocessable('scope_requires_step_up', 'A permission that needs an authenticator code cannot be given to an API key');
      if (!def.apiKeyScopable) throw unprocessable('scope_not_scopable', 'One of the scopes cannot be given to an API key');
    }
    const token = newApiKeyToken();
    const secretHash = apiKeySecretHash(this.config.AUTH_HMAC_KEY, token.prefix, token.secret);
    const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY_MS);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Locks the owner's row: two parallel requests cannot both pass the count below.
        await this.access.lockUsers(tx, [auth.userId]);
        await this.access.lockedActor(tx, auth.userId, INTEGRATIONS_PERMISSIONS.apiKeyManage);
        const held = await this.access.effectiveFor(tx, auth);
        if (input.scopes.some((s) => !held.keys.has(s))) throw unprocessable('scope_not_held', 'You can only give an API key permissions you have');
        const active = await tx.apiKey.count({ where: { ownerUserId: auth.userId, revokedAt: null, expiresAt: { gt: now } } });
        if (active >= MAX_ACTIVE_KEYS_PER_OWNER) throw unprocessable('too_many_api_keys', `You can have at most ${MAX_ACTIVE_KEYS_PER_OWNER} active API keys`);
        const row = await tx.apiKey.create({
          data: {
            name: input.name, prefix: token.prefix, secretHash,
            scopes: [...input.scopes].sort(), ownerUserId: auth.userId, expiresAt, createdAt: now,
          },
          select: { id: true },
        });
        await this.audit.record(tx, {
          actor, action: 'integrations.apiKey.created', entityType: 'ApiKey', entityId: row.id,
          // secretHash is @secret: the audit keeps only "[changed]".
          after: { name: input.name, prefix: token.prefix, secretHash, scopes: [...input.scopes].sort(), ownerUserId: auth.userId, expiresAt },
        });
        return { id: row.id, prefix: token.prefix, token: token.token, expiresAt: expiresAt.toISOString() };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('try_again', 'Please try again');
      throw e;
    }
  }

  async revoke(actor: AuditActor & { id: string }, id: string, now: Date = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now, revokedById: actor.id, revokeReason: 'manual' } });
      if (r.count === 0) {
        if (!(await tx.apiKey.findUnique({ where: { id }, select: { id: true } }))) throw notFound('api_key_not_found', 'API key not found');
        throw conflict('already_revoked', 'This API key is already revoked');
      }
      await this.audit.record(tx, {
        actor, action: 'integrations.apiKey.revoked', entityType: 'ApiKey', entityId: id,
        before: { revokedAt: null, revokeReason: null }, after: { revokedAt: now, revokeReason: 'manual' },
      });
    });
  }
}
