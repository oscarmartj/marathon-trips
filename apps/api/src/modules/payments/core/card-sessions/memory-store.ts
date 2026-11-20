// The memory card session store (plan docs/plans/4.4-au-card-gateway.md, section 12.1): for contract subjects and unit
// tests, with the same rules as the database. Its clock can be moved, so a subject can end a session at its expiry.
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  CardRefundIntent, CardRefundIntentChange, CardRefundIntentInit, CardSession, CardSessionChange, CardSessionInit, CardSessionStore, CardSessionTask, SessionChargeRow,
} from './store';
import { DEFAULT_SESSION_LIFETIME_MS, intentTransitionProblem, sessionTransitionProblem } from './store';

export class MemoryCardSessionStore implements CardSessionStore {
  readonly sessions = new Map<string, CardSession>();
  readonly charges = new Map<string, SessionChargeRow & { sessionId: string }>();
  readonly intents = new Map<string, CardRefundIntent>();
  readonly tasks: Array<{ kind: CardSessionTask; accountId: string; subject: string }> = [];
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  /** Moves this store's clock forward (contract subjects: the end the gateway gives an unpaid object). */
  advance(ms: number): void {
    this.offsetMs += ms;
  }

  async createOrGet(init: CardSessionInit): Promise<CardSession> {
    const existing = await this.byKey(init.accountId, init.idempotencyKey);
    if (existing) return existing;
    const s: CardSession = {
      ...init, id: randomUUID(), ref: `cs_${randomBytes(16).toString('hex')}`, status: 'open', chargeRef: null, chargedMinor: null, failureCode: null,
      authRef: null, authCardHash: null, submittedAt: null, verifyCalls: 0, expiresAt: new Date(init.createdAt.getTime() + DEFAULT_SESSION_LIFETIME_MS), version: 1,
    };
    this.sessions.set(s.id, s);
    return { ...s };
  }

  private find(pred: (s: CardSession) => boolean): CardSession | null {
    for (const s of this.sessions.values()) if (pred(s)) return { ...s };
    return null;
  }

  async byRef(accountId: string, ref: string): Promise<CardSession | null> {
    return this.find((s) => s.accountId === accountId && s.ref === ref);
  }

  async byKey(accountId: string, idempotencyKey: string): Promise<CardSession | null> {
    return this.find((s) => s.accountId === accountId && s.idempotencyKey === idempotencyKey);
  }

  async byChargeRef(accountId: string, chargeRef: string): Promise<CardSession | null> {
    return this.find((s) => s.accountId === accountId && s.chargeRef === chargeRef);
  }

  async unresolvedOfBooking(accountId: string, bookingId: string): Promise<CardSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.accountId === accountId && s.bookingId === bookingId && (s.status === 'submitting' || (s.status === 'failed' && s.chargeRef === null && s.submittedAt !== null && (s.failureCode === 'outcome_unknown' || s.failureCode === 'provider_busy'))))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((s) => ({ ...s }));
  }

  async update(s: CardSession, change: CardSessionChange): Promise<CardSession | null> {
    const current = this.sessions.get(s.id);
    if (!current || current.version !== s.version) return null;
    const problem = sessionTransitionProblem(current, change);
    if (problem) throw new Error(problem);
    if (change.chargeRef && this.find((o) => o.id !== s.id && o.accountId === s.accountId && o.chargeRef === change.chargeRef)) throw new Error('card_session_charge_unique');
    const next: CardSession = { ...current, ...change, version: current.version + 1 };
    this.sessions.set(s.id, next);
    return { ...next };
  }

  async recordCharge(s: CardSession, c: SessionChargeRow): Promise<boolean> {
    if (this.charges.has(c.chargeRef)) return false;
    this.charges.set(c.chargeRef, { ...c, sessionId: s.id });
    return true;
  }

  private findIntent(pred: (i: CardRefundIntent) => boolean): CardRefundIntent | null {
    for (const i of this.intents.values()) if (pred(i)) return { ...i };
    return null;
  }

  async intentByKey(accountId: string, idempotencyKey: string): Promise<CardRefundIntent | null> {
    return this.findIntent((i) => i.accountId === accountId && i.idempotencyKey === idempotencyKey);
  }

  async intentByRefundRef(accountId: string, refundRef: string): Promise<CardRefundIntent | null> {
    return this.findIntent((i) => i.accountId === accountId && i.refundRef === refundRef);
  }

  async submittingIntents(accountId: string, chargeRef: string): Promise<CardRefundIntent[]> {
    return [...this.intents.values()].filter((i) => i.accountId === accountId && i.chargeRef === chargeRef && i.status === 'submitting').map((i) => ({ ...i }));
  }

  async createIntent(init: CardRefundIntentInit): Promise<CardRefundIntent> {
    const existing = await this.intentByKey(init.accountId, init.idempotencyKey);
    if (existing) return existing;
    const i: CardRefundIntent = { ...init, id: randomUUID(), status: 'new', refundRef: null, lastAnswer: null, createdAt: this.now(), updatedAt: this.now(), version: 1 };
    this.intents.set(i.id, i);
    return { ...i };
  }

  async updateIntent(i: CardRefundIntent, change: CardRefundIntentChange): Promise<CardRefundIntent | null> {
    const current = this.intents.get(i.id);
    if (!current || current.version !== i.version) return null;
    const problem = intentTransitionProblem(current, change);
    if (problem) throw new Error(problem);
    if (change.refundRef && this.findIntent((o) => o.id !== i.id && o.accountId === i.accountId && o.refundRef === change.refundRef)) return null;
    const next: CardRefundIntent = { ...current, status: change.status, refundRef: change.refundRef ?? current.refundRef, lastAnswer: change.lastAnswer ?? null, updatedAt: this.now(), version: current.version + 1 };
    this.intents.set(i.id, next);
    return { ...next };
  }

  async openTask(kind: CardSessionTask, accountId: string, subject: string): Promise<void> {
    if (!this.tasks.some((t) => t.kind === kind && t.subject === subject)) this.tasks.push({ kind, accountId, subject });
  }
}
