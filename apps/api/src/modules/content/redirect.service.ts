import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { createRedirectSchema, updateRedirectSchema } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { type Tx, assertVersion, defined, orConflict, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };

/** Paths the web app owns: a redirect from one of these could lock staff out of the panel or break the API proxy. */
const RESERVED = /^\/(admin|api|_next)(\/|$)/;
const MAX_HOPS = 10;

/** `/faq/` and `/faq` are the same address. The root is never a redirect source. */
export const normalisePath = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p);
const pathOf = (target: string): string | null => (target.startsWith('/') ? normalisePath(target.split(/[?#]/, 1)[0]!) : null);

/**
 * Follows the redirects from `start` and says whether they come back to a path already visited (a loop) or run past
 * MAX_HOPS (a chain browsers will not follow). Only enabled redirects count; an address outside the site ends the chain.
 */
export function redirectProblem(start: string, target: string, others: ReadonlyArray<{ fromPath: string; toPath: string }>): 'loop' | 'chain' | null {
  const next = new Map(others.map((r) => [r.fromPath, r.toPath]));
  next.set(start, target);
  const seen = new Set<string>([start]);
  let current: string | null = pathOf(target);
  for (let hops = 1; current !== null; hops++) {
    if (seen.has(current)) return 'loop';
    if (hops >= MAX_HOPS) return 'chain';
    seen.add(current);
    const to = next.get(current);
    current = to === undefined ? null : pathOf(to);
  }
  return null;
}

/** Redirects staff manage in the panel. The web app reads the enabled ones from the public API and applies them. */
@Injectable()
export class RedirectService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list() {
    return view({ items: await this.prisma.contentRedirect.findMany({ orderBy: [{ fromPath: 'asc' }], take: 1000 }) });
  }

  async get(id: string) {
    const row = await this.prisma.contentRedirect.findUnique({ where: { id } });
    if (!row) throw notFound('content_not_found', 'Not found');
    return view(row);
  }

  async create(actor: Actor, input: z.infer<typeof createRedirectSchema>) {
    const { reason, ...data } = input;
    const fromPath = normalisePath(data.fromPath);
    const row = await orConflict('redirect_exists', 'There is already a redirect from this address', () =>
      this.prisma.$transaction(async (tx) => {
        await this.check(tx, null, fromPath, data.toPath, data.enabled);
        const created = await tx.contentRedirect.create({ data: { ...data, fromPath } });
        await this.audit.record(tx, { actor, action: 'content.redirect.created', entityType: 'ContentRedirect', entityId: created.id, reason, after: view(created) });
        return created;
      }),
    );
    return this.get(row.id);
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateRedirectSchema>) {
    const { version, reason, ...rest } = input;
    const changes = defined(rest);
    if (changes.fromPath !== undefined) changes.fromPath = normalisePath(changes.fromPath);
    await orConflict('redirect_exists', 'There is already a redirect from this address', () =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.contentRedirect.findUnique({ where: { id } });
        assertVersion(before, version, 'Not found');
        const merged = { ...before, ...changes };
        await this.check(tx, id, merged.fromPath, merged.toPath, merged.enabled);
        const res = await tx.contentRedirect.updateMany({ where: { id, version }, data: { ...changes, version: { increment: 1 } } });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.contentRedirect.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'content.redirect.updated', entityType: 'ContentRedirect', entityId: id, reason, before: view(before), after: view(after) });
      }),
    );
    return this.get(id);
  }

  async remove(actor: Actor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.contentRedirect.findUnique({ where: { id } });
      if (!before) throw notFound('content_not_found', 'Not found');
      await tx.contentRedirect.delete({ where: { id } });
      await this.audit.record(tx, { actor, action: 'content.redirect.deleted', entityType: 'ContentRedirect', entityId: id, reason, before: view(before) });
    });
  }

  /** Reserved paths, a redirect to itself, and loops or long chains through the enabled redirects. */
  private async check(tx: Tx, selfId: string | null, fromPath: string, toPath: string, enabled: boolean): Promise<void> {
    if (RESERVED.test(fromPath)) throw unprocessable('redirect_path_reserved', 'The panel, the API and the site files cannot be redirected');
    if (pathOf(toPath) === fromPath) throw conflict('redirect_loop', 'This redirect would send visitors back to the same address');
    if (!enabled) return;
    const others = await tx.contentRedirect.findMany({ where: { enabled: true, ...(selfId ? { id: { not: selfId } } : {}) }, select: { fromPath: true, toPath: true } });
    const problem = redirectProblem(fromPath, toPath, others);
    if (problem === 'loop') throw conflict('redirect_loop', 'These redirects would send visitors round in a circle');
    if (problem === 'chain') throw conflict('redirect_chain_too_long', 'These redirects form a chain that is too long. Point this one at the final address.');
  }
}
