import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AppError } from '../errors/safe-error';
import { canonicalJson, sha256Hex } from '../crypto/hmac';

export type IdempotencyActorType = 'staff' | 'customer' | 'api_key' | 'token';

export interface IdempotencyRequest {
  actorType: IdempotencyActorType;
  /** A user id, an API key id, or for a token route the hash of the token (never the token). */
  actorId: string;
  /** Route template, such as POST /bookings. */
  route: string;
  /** The client's Idempotency-Key header. */
  key: string;
  body: unknown;
}

export interface IdempotentResult {
  /** HTTP status the first call answered with. */
  status: number;
  resourceType?: string;
  resourceId?: string;
}

export type IdempotencyOutcome =
  | { replayed: false; result: IdempotentResult }
  /** The caller renders the CURRENT representation of the resource: no response body is stored (plan 4.1). */
  | { replayed: true; result: IdempotentResult };

const TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 60 * 1000;

export class IdempotencyKeyReuseError extends HttpException {
  constructor() {
    super({ code: 'idempotency_key_reused', message: 'This Idempotency-Key was used with a different request body' }, 422);
  }
}
export class IdempotencyInProgressError extends HttpException {
  constructor() {
    super({ code: 'idempotency_in_progress', message: 'A request with this Idempotency-Key is still being processed' }, 409);
  }
}

@Injectable()
export class IdempotencyService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  static scope(req: Pick<IdempotencyRequest, 'actorType' | 'actorId' | 'route'>): string {
    return `${req.actorType}:${req.actorId}:${req.route}`;
  }

  /**
   * Runs `handler` once per (scope, key). A repeat with the same body returns the stored status and resource
   * reference without running the handler; a different body is 422; a live in-progress record is 409. If the
   * handler throws, the record is removed so the client's retry runs it again (business operations must still be
   * idempotent themselves: this does not replace that). Public routes without a token cannot use idempotency.
   */
  async run(req: IdempotencyRequest, handler: () => Promise<IdempotentResult>, now: Date = new Date()): Promise<IdempotencyOutcome> {
    if (!req.actorId || !req.key) throw new AppError('idempotency_requires_actor_and_key', 'An actor and an Idempotency-Key are required');
    const scope = IdempotencyService.scope(req);
    const requestHash = sha256Hex(canonicalJson(req.body ?? null));
    const lockedUntil = new Date(now.getTime() + LOCK_MS);

    let owned = false;
    for (let attempt = 0; attempt < 3 && !owned; attempt += 1) {
      try {
        await this.prisma.idempotencyRecord.create({
          data: { scope, actorType: req.actorType, actorId: req.actorId, key: req.key, requestHash, lockedUntil, expiresAt: new Date(now.getTime() + TTL_MS) },
        });
        owned = true; // we own the key
        continue;
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
        const existing = await this.prisma.idempotencyRecord.findUnique({ where: { scope_key: { scope, key: req.key } } });
        if (!existing) continue; // deleted between the insert and the read: try again
        if (existing.expiresAt <= now) {
          await this.prisma.idempotencyRecord.deleteMany({ where: { id: existing.id, expiresAt: { lte: now } } });
          continue;
        }
        if (existing.requestHash !== requestHash) throw new IdempotencyKeyReuseError();
        if (existing.status === 'completed') {
          return {
            replayed: true,
            result: { status: existing.responseStatus ?? 200, resourceType: existing.resourceType ?? undefined, resourceId: existing.resourceId ?? undefined },
          };
        }
        if (existing.lockedUntil && existing.lockedUntil > now) throw new IdempotencyInProgressError();
        // The first caller died holding the lock: take it over, atomically.
        const taken = await this.prisma.idempotencyRecord.updateMany({
          where: { id: existing.id, status: 'in_progress', lockedUntil: existing.lockedUntil },
          data: { lockedUntil },
        });
        if (taken.count !== 1) throw new IdempotencyInProgressError();
        owned = true;
      }
    }
    if (!owned) throw new IdempotencyInProgressError();

    try {
      const result = await handler();
      await this.prisma.idempotencyRecord.updateMany({
        where: { scope, key: req.key },
        data: { status: 'completed', responseStatus: result.status, resourceType: result.resourceType ?? null, resourceId: result.resourceId ?? null, lockedUntil: null },
      });
      return { replayed: false, result };
    } catch (err) {
      await this.prisma.idempotencyRecord.deleteMany({ where: { scope, key: req.key, status: 'in_progress' } });
      throw err;
    }
  }
}
