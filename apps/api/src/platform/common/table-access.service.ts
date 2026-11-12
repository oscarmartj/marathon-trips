import { Inject, Injectable } from '@nestjs/common';
import { AccessService, type Effective } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { actorOf } from '../access/actor';
import { PrismaService } from '../database/prisma.service';
import { EntityRegistry } from '../entities/entity-registry';
import { forbidden, notFound } from '../http/api-error';
import type { ApiRequest } from '../http/request-context';
import type { Actor, TableDef } from './table-def';

export interface Caller {
  auth: AuthContext;
  actor: Actor;
}

export const callerOf = (req: ApiRequest): Caller => ({ auth: req.auth!, actor: actorOf(req) });

type Capability = keyof TableDef['permissions'];

/** Finds a registered table by the entity type in a URL and checks the table's own permission (fail closed). */
@Injectable()
export class TableAccessService {
  constructor(
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  def(entityType: string): TableDef {
    const table = this.entities.get(entityType)?.table;
    if (!table) throw notFound('unknown_table', 'Table not found');
    return table;
  }

  /** `annotate` falls back to `write`. A capability the table does not declare is refused. */
  async require(caller: Caller, def: TableDef, cap: Capability): Promise<Effective> {
    const key = cap === 'annotate' ? (def.permissions.annotate ?? def.permissions.write) : def.permissions[cap];
    if (!key) throw forbidden();
    return this.access.assertPermission(this.prisma, caller.auth, key);
  }

  async has(caller: Caller, def: TableDef, cap: Capability): Promise<boolean> {
    try {
      await this.require(caller, def, cap);
      return true;
    } catch {
      return false;
    }
  }

  async hasKey(caller: Caller, key: string): Promise<boolean> {
    try {
      await this.assertKey(caller, key);
      return true;
    } catch {
      return false;
    }
  }

  /** Permission keys the caller holds, for services that filter by key (search). */
  effective(caller: Caller): Promise<Effective> {
    return this.access.effectiveFor(this.prisma, caller.auth);
  }

  /** Throws unless the caller holds a platform-level key such as common.tag.manage. */
  assertKey(caller: Caller, key: string): Promise<Effective> {
    return this.access.assertPermission(this.prisma, caller.auth, key);
  }
}
