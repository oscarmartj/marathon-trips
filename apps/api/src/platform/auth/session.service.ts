import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthContext, UserKind } from '../access/auth-context';
import type { AppConfig } from '../config/config';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import type { RequestMeta } from './request-meta';
import { looksLikeToken, newToken, tokenHash } from './tokens';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Plan 4.2: staff 12 h absolute and 2 h idle; customers 30 days absolute and 7 days idle. */
export const SESSION_LIFETIME: Record<UserKind, { absoluteMs: number; idleMs: number }> = {
  staff: { absoluteMs: 12 * HOUR, idleMs: 2 * HOUR },
  customer: { absoluteMs: 30 * DAY, idleMs: 7 * DAY },
};
const TOUCH_EVERY_MS = 60_000;

export type RevokeReason = 'sign_out' | 'user_disabled' | 'enrolment_reset' | 'step_up_failures';

@Injectable()
export class SessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get secureCookies(): boolean {
    return this.config.COOKIE_SECURE;
  }

  /** A new random token on every sign-in (no fixation); only its hash is stored. */
  async create(tx: Prisma.TransactionClient, input: { userId: string; kind: UserKind; mfaVerifiedAt: Date | null; meta: RequestMeta; now?: Date }) {
    const now = input.now ?? new Date();
    const life = SESSION_LIFETIME[input.kind];
    const token = newToken();
    const expiresAt = new Date(now.getTime() + life.absoluteMs);
    const session = await tx.session.create({
      data: {
        userId: input.userId, kind: input.kind, tokenHash: tokenHash(token), createdAt: now, lastSeenAt: now, expiresAt,
        idleExpiresAt: new Date(Math.min(now.getTime() + life.idleMs, expiresAt.getTime())), mfaVerifiedAt: input.mfaVerifiedAt,
        userAgent: input.meta.userAgent, ipPrefix: input.meta.ipPrefix,
      },
      select: { id: true },
    });
    return { token, sessionId: session.id, maxAgeSeconds: Math.floor(life.absoluteMs / 1000) };
  }

  /** The session for this cookie, if it is live, of this kind, and its user is active. Pushes the idle expiry forward. */
  async authenticate(kind: UserKind, token: string | undefined, now: Date = new Date()): Promise<AuthContext | null> {
    if (!looksLikeToken(token)) return null;
    const s = await this.prisma.session.findUnique({
      where: { tokenHash: tokenHash(token) },
      select: { id: true, userId: true, kind: true, expiresAt: true, idleExpiresAt: true, lastSeenAt: true, revokedAt: true, mfaVerifiedAt: true, user: { select: { kind: true, status: true } } },
    });
    if (!s || s.kind !== kind || s.user.kind !== kind || s.revokedAt || s.user.status !== 'active') return null;
    if (s.expiresAt <= now || s.idleExpiresAt <= now) return null;
    if (now.getTime() - s.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
      const idle = new Date(Math.min(now.getTime() + SESSION_LIFETIME[kind].idleMs, s.expiresAt.getTime()));
      await this.prisma.session.updateMany({ where: { id: s.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt: idle } });
    }
    return { kind, userId: s.userId, sessionId: s.id, mfaVerifiedAt: s.mfaVerifiedAt };
  }

  async revoke(db: Prisma.TransactionClient | PrismaService, sessionId: string, reason: RevokeReason): Promise<void> {
    await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
  }

  async revokeAllForUser(db: Prisma.TransactionClient | PrismaService, userId: string, reason: RevokeReason): Promise<number> {
    const r = await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
    return r.count;
  }
}
