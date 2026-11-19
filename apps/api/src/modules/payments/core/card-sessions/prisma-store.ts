// The database card session store (plan docs/plans/4.4-au-card-gateway.md, sections 11 and 12.1): tables of migration
// 0039, whose triggers apply the transition rules again. Every change is a compare-and-set on `version`.
import { randomBytes } from 'node:crypto';
import type { CardSessionFailure } from '@mt/shared';
import type { PrismaService } from '../../../../platform/database/prisma.service';
import { runTransaction } from '../../../../platform/database/transaction';
import type { TasksService } from '../../../../platform/common/tasks/tasks.service';
import type { PaymentModeName } from '../provider';
import type {
  CardRefundIntent, CardRefundIntentChange, CardRefundIntentInit, CardRefundIntentStatus, CardRefundLastAnswer, CardSession, CardSessionChange, CardSessionInit,
  CardSessionStatus, CardSessionStore, CardSessionTask, SessionChargeRow,
} from './store';
import { DEFAULT_SESSION_LIFETIME_MS, SESSION_MARGIN_MS, intentTransitionProblem, sessionTransitionProblem } from './store';

interface SessionRow {
  id: string; ref: string; providerAccountId: string; mode: PaymentModeName; idempotencyKey: string; paymentId: string; bookingId: string;
  currency: string; amountMinor: bigint; returnUrl: string; status: string; chargeRef: string | null; chargedMinor: bigint | null; failureCode: string | null;
  submittedAt: Date | null; verifyCalls: number; createdAt: Date; expiresAt: Date; version: number;
}
interface IntentRow {
  id: string; providerAccountId: string; mode: PaymentModeName; idempotencyKey: string; refundId: string; chargeRef: string; amountMinor: bigint; currency: string;
  status: string; refundRef: string | null; lastAnswer: string | null; createdAt: Date; version: number;
}

const toSession = (r: SessionRow): CardSession => ({
  id: r.id, ref: r.ref, accountId: r.providerAccountId, mode: r.mode, idempotencyKey: r.idempotencyKey, paymentId: r.paymentId, bookingId: r.bookingId,
  amountMinor: r.amountMinor, currency: r.currency, returnUrl: r.returnUrl, status: r.status as CardSessionStatus, chargeRef: r.chargeRef, chargedMinor: r.chargedMinor,
  failureCode: r.failureCode as CardSessionFailure | null, submittedAt: r.submittedAt, verifyCalls: r.verifyCalls, createdAt: r.createdAt, expiresAt: r.expiresAt, version: r.version,
});
const toIntent = (r: IntentRow): CardRefundIntent => ({
  id: r.id, accountId: r.providerAccountId, mode: r.mode, idempotencyKey: r.idempotencyKey, refundId: r.refundId, chargeRef: r.chargeRef, amountMinor: r.amountMinor,
  currency: r.currency, status: r.status as CardRefundIntentStatus, refundRef: r.refundRef, lastAnswer: r.lastAnswer as CardRefundLastAnswer | null, createdAt: r.createdAt, version: r.version,
});

const TASK_TITLES: Record<CardSessionTask, string> = {
  extra_charge: 'Card charge outside its payment',
  reference_mismatch: 'Card authentication for another charge',
  refund_conflict: 'Card refund answered twice',
  refund_candidates: 'Card refund cannot be matched',
  declines_spike: 'Many declined cards on one account',
};
const TASK_TEXT: Record<CardSessionTask, string> = {
  extra_charge: 'The gateway reports a charge under a card session that is not the session\'s own. If it collected money, refund it or register it against the right booking.',
  reference_mismatch: 'A customer came back from 3-D Secure with a session token of another charge. Nothing was recorded; check the charge at the gateway.',
  refund_conflict: 'A refund request was answered with a refund other than the one already recorded for it. Check both refunds at the gateway.',
  refund_candidates: 'More than one refund at the gateway could be the answer to one request of ours. Check them at the gateway and resolve the refund.',
  declines_spike: 'More than 20 cards were declined on this account within an hour. Someone may be testing cards; nothing was blocked.',
};

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === 'P2002';

export class PrismaCardSessionStore implements CardSessionStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  now(): Date {
    return new Date();
  }

  async createOrGet(init: CardSessionInit): Promise<CardSession> {
    const existing = await this.byKey(init.accountId, init.idempotencyKey);
    if (existing) return existing;
    // Plan 4.4, 18 m6: the attempt's own expiry + 30 min, from its row; without one, the default lifetime.
    const payment = await this.prisma.payment.findUnique({ where: { id: init.paymentId }, select: { pendingExpiresAt: true } }).catch(() => null);
    const expiresAt = payment?.pendingExpiresAt ? new Date(payment.pendingExpiresAt.getTime() + SESSION_MARGIN_MS) : new Date(init.createdAt.getTime() + DEFAULT_SESSION_LIFETIME_MS);
    try {
      const row = await this.prisma.cardSession.create({
        data: {
          ref: `cs_${randomBytes(16).toString('hex')}`, providerAccountId: init.accountId, mode: init.mode, idempotencyKey: init.idempotencyKey, paymentId: init.paymentId,
          bookingId: init.bookingId, currency: init.currency, amountMinor: init.amountMinor, returnUrl: init.returnUrl, expiresAt, createdAt: init.createdAt,
        },
      });
      return toSession(row as SessionRow);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.byKey(init.accountId, init.idempotencyKey);
      if (!raced) throw err;
      return raced;
    }
  }

  async byRef(accountId: string, ref: string): Promise<CardSession | null> {
    const r = await this.prisma.cardSession.findFirst({ where: { providerAccountId: accountId, ref } });
    return r ? toSession(r as SessionRow) : null;
  }

  async byKey(accountId: string, idempotencyKey: string): Promise<CardSession | null> {
    const r = await this.prisma.cardSession.findUnique({ where: { providerAccountId_idempotencyKey: { providerAccountId: accountId, idempotencyKey } } });
    return r ? toSession(r as SessionRow) : null;
  }

  async byChargeRef(accountId: string, chargeRef: string): Promise<CardSession | null> {
    const r = await this.prisma.cardSession.findFirst({ where: { providerAccountId: accountId, chargeRef } });
    return r ? toSession(r as SessionRow) : null;
  }

  async update(s: CardSession, change: CardSessionChange): Promise<CardSession | null> {
    const problem = sessionTransitionProblem(s, change);
    if (problem) throw new Error(problem);
    const res = await this.prisma.cardSession.updateMany({
      where: { id: s.id, version: s.version },
      data: { ...change, version: s.version + 1, updatedAt: new Date() },
    });
    if (res.count === 0) return null;
    return this.byRef(s.accountId, s.ref);
  }

  async recordCharge(s: CardSession, c: SessionChargeRow): Promise<boolean> {
    try {
      await this.prisma.cardSessionCharge.create({ data: { sessionId: s.id, providerAccountId: s.accountId, mode: s.mode, chargeRef: c.chargeRef, success: c.success, amountMinor: c.amountMinor, currency: c.currency } });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async intentByKey(accountId: string, idempotencyKey: string): Promise<CardRefundIntent | null> {
    const r = await this.prisma.cardRefundIntent.findUnique({ where: { providerAccountId_idempotencyKey: { providerAccountId: accountId, idempotencyKey } } });
    return r ? toIntent(r as IntentRow) : null;
  }

  async intentByRefundRef(accountId: string, refundRef: string): Promise<CardRefundIntent | null> {
    const r = await this.prisma.cardRefundIntent.findFirst({ where: { providerAccountId: accountId, refundRef } });
    return r ? toIntent(r as IntentRow) : null;
  }

  async submittingIntents(accountId: string, chargeRef: string): Promise<CardRefundIntent[]> {
    const rows = await this.prisma.cardRefundIntent.findMany({ where: { providerAccountId: accountId, chargeRef, status: 'submitting' }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => toIntent(r as IntentRow));
  }

  async createIntent(init: CardRefundIntentInit): Promise<CardRefundIntent> {
    const existing = await this.intentByKey(init.accountId, init.idempotencyKey);
    if (existing) return existing;
    try {
      const row = await this.prisma.cardRefundIntent.create({
        data: { providerAccountId: init.accountId, mode: init.mode, idempotencyKey: init.idempotencyKey, refundId: init.refundId, chargeRef: init.chargeRef, amountMinor: init.amountMinor, currency: init.currency },
      });
      return toIntent(row as IntentRow);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.intentByKey(init.accountId, init.idempotencyKey);
      if (!raced) throw err;
      return raced;
    }
  }

  async updateIntent(i: CardRefundIntent, change: CardRefundIntentChange): Promise<CardRefundIntent | null> {
    const problem = intentTransitionProblem(i, change);
    if (problem) throw new Error(problem);
    try {
      const res = await this.prisma.cardRefundIntent.updateMany({
        where: { id: i.id, version: i.version },
        data: { status: change.status, ...(change.refundRef ? { refundRef: change.refundRef } : {}), lastAnswer: change.lastAnswer ?? null, version: i.version + 1, updatedAt: new Date() },
      });
      if (res.count === 0) return null;
    } catch (err) {
      // Another intent of this account already holds that refund: never rebound (plan 4.4, 18 m7).
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    return this.intentByKey(i.accountId, i.idempotencyKey);
  }

  async openTask(kind: CardSessionTask, accountId: string, subject: string): Promise<void> {
    await runTransaction(this.prisma, (tx) => this.tasks.createSystemIn(tx, {
      title: TASK_TITLES[kind], description: TASK_TEXT[kind], entityType: 'ProviderAccount', entityId: accountId, sourceRef: `payments:card_session_${kind}:${subject}`,
    }));
  }
}
