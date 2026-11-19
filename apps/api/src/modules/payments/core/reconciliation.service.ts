// The daily reconciliation of every gateway account against the gateway (plan docs/plans/4.6-reconciliation-receipts.md,
// section 2 and review R1-R12). Per account: the dispute sweep, the settlement import with its fees, then a read-only
// comparison of our payments, refunds and disputes with what the gateway says, and of the gateway's activity and
// payouts with ours. Each difference is a task (the alert: nobody is emailed) and the run is stored, closed once.
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import type { AppConfig } from '../../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { OutboxService } from '../../../platform/events/outbox.service';
import { SettingsService } from '../../../platform/flags/flags.service';
import { ApiError, conflict, notFound, tooManyRequests } from '../../../platform/http/api-error';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { todayInBrisbane } from '../../bookings';
import { PAYMENT_EVENTS } from './attempt-state';
import { DisputeSyncService } from './dispute-sync.service';
import { ProviderGateway } from './gateway';
import type { PaymentProvider, ProviderActivity, ProviderContext } from './provider';
import { ProviderError } from './provider';
import { CUT_OFF_AFTER, CUT_OFF_CODES, Difference, dedupe, differencesSchema, moneySide } from './reconciliation-types';
import { LATE_PENDING_CODE, PaymentRefundStateMachine } from './refunds.service';
import { readBookingForPayments } from '../../bookings';
import { runTransaction } from '../../../platform/database/transaction';
import { PAYMENT_TX_OPTIONS } from './payable-states';
import { PAYMENT_SETTINGS } from './settings';
import { SettlementsService } from './settlements.service';
import type { GatewayCaller } from './settlements.service';

type Mode = 'test' | 'live';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Objects changed this recently are in flight (a webhook on its way): not compared (plan 4.6, 2.3). */
export const SETTLE_MS = HOUR;
/** A run still `running` after this died: the next run closes it as failed (review R11). */
export const STALE_RUN_MS = 6 * HOUR;
export const MANUAL_RUNS_PER_HOUR = 5;
/** Adapters with no gateway to compare with: their reconciliation is the bank statement (out of scope). */
const NO_GATEWAY: ReadonlySet<string> = new Set(['manual']);

/** One open task per difference and object (codes only, at most 80 characters: the audit's rule). */
export const reconciliationTaskRef = (code: string, entityId: string): string =>
  `payments:recon:${createHash('sha256').update(`${code}:${entityId}`).digest('hex').slice(0, 40)}`;

class CutOff extends Error {
  constructor(readonly code: string) {
    super(`reconciliation cut off: ${code}`);
  }
}

export interface RunOptions {
  /** The time the run is for; by default the database's clock (code review, minor 8). */
  now?: Date;
  /** Tests only: a smaller object cap than the setting allows. */
  maxObjects?: number;
  trigger?: 'scheduled' | 'manual';
  actor?: AuditActor;
}

export interface RunView {
  id: string;
  providerAccountId: string;
  forDate: string;
  attempt: number;
  trigger: string;
  status: string;
  errorCode: string | null;
  checkedObjects: number;
  differences: Difference[];
  startedAt: Date;
  finishedAt: Date | null;
}

const TASK_ENTITY: Readonly<Record<Difference['entityType'], 'Payment' | 'Refund' | 'Dispute' | null>> = {
  Payment: 'Payment', Refund: 'Refund', Dispute: 'Dispute', Settlement: null, SettlementLine: null, GatewayObject: null,
};

@Injectable()
export class ReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PaymentsReconciliation');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(SettlementsService) private readonly settlements: SettlementsService,
    @Inject(DisputeSyncService) private readonly disputes: DisputeSyncService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PaymentRefundStateMachine) private readonly refunds: PaymentRefundStateMachine,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.paymentsReconciliation, async () => void (await this.runAll()));
    // 18:10 UTC is 04:10 in Brisbane, after the internal ledger check (03:40).
    await this.jobs.schedule(QUEUES.paymentsReconciliation, '10 18 * * *');
  }

  /** Every account of the environment's mode, one after another; a failing account never stops the others. */
  async runAll(opts: RunOptions = {}): Promise<RunView[]> {
    const now = opts.now ?? (await this.dbNow());
    const accounts = await this.accountsToReconcile(now);
    const out: RunView[] = [];
    for (const a of accounts) {
      try {
        const run = await this.runAccount(a.id, { ...opts, now, trigger: 'scheduled' });
        if (run) out.push(run);
      } catch (err) {
        this.logger.warn(`reconciliation of an account did not run (${(err as { code?: string }).code ?? 'error'})`);
      }
    }
    await this.overdue(now, accounts);
    return out;
  }

  /**
   * The accounts of the environment's mode a scheduled run covers. An archived account is reconciled while a dispute can
   * still reach it (its dispute window after archiving), not for ever (code review, minor 8).
   */
  async accountsToReconcile(now: Date): Promise<Array<{ id: string; createdAt: Date }>> {
    const windowDays = await this.settings.get<number>(PAYMENT_SETTINGS.disputeWindowDays.key, PAYMENT_SETTINGS.disputeWindowDays.fallback);
    return this.prisma.providerAccount.findMany({
      where: { mode: this.gateway.mode, OR: [{ status: { not: 'archived' } }, { updatedAt: { gt: new Date(now.getTime() - windowDays * DAY) } }] },
      select: { id: true, createdAt: true }, orderBy: { id: 'asc' },
    });
  }

  /**
   * One account, now. Null when another run of the account is in progress (a scheduled run skips it; a manual one gets
   * 409 from the controller path). The run row is inserted first (one running per account, review R11) and closed at
   * the end with its status and differences.
   */
  async runAccount(accountId: string, opts: RunOptions = {}): Promise<RunView | null> {
    const now = opts.now ?? (await this.dbNow());
    const trigger = opts.trigger ?? 'scheduled';
    const account = await this.prisma.providerAccount.findUnique({ where: { id: accountId }, select: { id: true, mode: true, adapterKey: true } });
    if (!account || account.mode !== this.gateway.mode) throw notFound('provider_account_not_found', 'Payment gateway account not found');
    const mode = account.mode as Mode;
    const forDate = todayInBrisbane(now);
    await this.prisma.$executeRaw`
      UPDATE reconciliation_runs SET status = 'failed', "errorCode" = 'stale_run', "finishedAt" = now()
      WHERE "providerAccountId" = ${accountId}::uuid AND status = 'running' AND "startedAt" < now() - make_interval(secs => ${STALE_RUN_MS / 1000})`;
    const runId = await this.start(accountId, mode, forDate, trigger, opts.actor);
    if (!runId) return null;

    const provider = this.gateway.registry.get(account.adapterKey);
    if (!provider || NO_GATEWAY.has(account.adapterKey)) return this.close(runId, accountId, forDate, 'not_applicable', null, 0, []);

    const differences: Difference[] = [];
    let checked = 0;
    let incomplete: string | null = null;
    const call = this.caller(accountId);
    const caps = provider.manifest.capabilities.reconciliation;
    try {
      const lookback = await this.settings.get<number>(PAYMENT_SETTINGS.reconciliationLookbackDays.key, PAYMENT_SETTINGS.reconciliationLookbackDays.fallback);
      const maxObjects = opts.maxObjects ?? await this.settings.get<number>(PAYMENT_SETTINGS.reconciliationMaxObjects.key, PAYMENT_SETTINGS.reconciliationMaxObjects.fallback);
      const since = new Date(now.getTime() - lookback * DAY);
      const settled = new Date(now.getTime() - SETTLE_MS);

      // 1. Disputes whose last webhook may have been lost (review of 4.5, limit 4).
      if (provider.manifest.capabilities.disputes) {
        const swept = await this.disputes.sweep(accountId, mode, `${forDate}:${runId}`, call, { now, settleMs: SETTLE_MS });
        differences.push(...swept.differences);
        checked += swept.checked;
        // Round 2 review: a dispute the gateway answered badly was not checked, so the run cannot be `matched`.
        if (swept.errors > 0) incomplete = incomplete ?? 'gateway_errors';
      }
      // 2. Settlements and their fees (review R4: matching and posting resume from what is stored).
      if (caps?.settlements && provider.listSettlements) {
        const last = await this.prisma.settlement.findFirst({ where: { providerAccountId: accountId }, orderBy: { payoutDate: 'desc' }, select: { payoutDate: true } });
        const from = last ? new Date(last.payoutDate.getTime() - 7 * DAY) : since;
        try {
          const imported = await this.settlements.importAccount(accountId, mode, from.toISOString().slice(0, 10), call);
          differences.push(...imported.differences);
          checked += imported.listed;
        } catch (err) {
          if (err instanceof CutOff || !(err instanceof ProviderError)) throw err;
          if (err.code === 'provider_auth_failed') throw err;
          incomplete = 'settlements_not_listed';
        }
        differences.push(...(await this.settlements.matchPending(accountId, mode)));
        await this.settlements.postMissingFees(accountId, mode);
      }
      // 3. Our objects against the gateway.
      const objects = await this.compareObjects(accountId, mode, call, { since, settled, maxObjects });
      differences.push(...objects.differences);
      checked += objects.checked;
      if (objects.capped) incomplete = incomplete ?? 'object_cap';
      if (objects.errors > 0) incomplete = incomplete ?? 'gateway_errors';
      // 4. The gateway's activity against ours.
      if (caps?.activity && provider.listActivity) {
        try {
          const act = await this.compareActivity(accountId, mode, call, { since, settled, forDate, runId });
          differences.push(...act.differences);
          checked += act.checked;
        } catch (err) {
          if (err instanceof CutOff || !(err instanceof ProviderError)) throw err;
          if (err.code === 'provider_auth_failed') throw err;
          incomplete = incomplete ?? 'activity_not_listed';
        }
      }
      // 5. Internal: receipts and payouts that should exist by now.
      differences.push(...(await this.internal(accountId, mode, { settled, since, graceDays: caps?.settlements ? await this.settings.get<number>(PAYMENT_SETTINGS.settlementGraceDays.key, PAYMENT_SETTINGS.settlementGraceDays.fallback) : null, now })));
    } catch (err) {
      const code = err instanceof CutOff ? err.code : err instanceof ProviderError ? err.code : err instanceof ApiError ? err.code : 'reconciliation_error';
      const safe = /^[a-z0-9_]{1,64}$/.test(code) ? code : 'reconciliation_error';
      return this.close(runId, accountId, forDate, 'failed', safe, checked, dedupe(differences));
    }
    const list = dedupe(differences);
    const status = list.length > 0 ? 'mismatch' : incomplete ? 'partial' : 'matched';
    return this.close(runId, accountId, forDate, status, incomplete, checked, list);
  }

  /** The manual run from the panel: permission and step-up are checked by the route; at most a few an hour per person. */
  async runManually(accountId: string, actor: AuditActor): Promise<RunView> {
    if (!actor.id) throw conflict('actor_required', 'A person must ask for a manual run');
    const recent = await this.prisma.reconciliationRun.count({ where: { triggeredById: actor.id, trigger: 'manual', startedAt: { gt: new Date(Date.now() - HOUR) } } });
    if (recent >= MANUAL_RUNS_PER_HOUR) throw tooManyRequests(3600);
    const run = await this.runAccount(accountId, { trigger: 'manual', actor });
    if (!run) throw conflict('reconciliation_running', 'A reconciliation of this account is already running');
    return run;
  }

  private async dbNow(): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    return row?.now ?? new Date();
  }

  private async start(accountId: string, mode: Mode, forDate: string, trigger: 'scheduled' | 'manual', actor?: AuditActor): Promise<string | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO reconciliation_runs (id, "providerAccountId", mode, "forDate", attempt, trigger, "triggeredById")
          SELECT gen_random_uuid(), ${accountId}::uuid, ${mode}::"PaymentMode", ${forDate}::date,
                 COALESCE((SELECT MAX(attempt) FROM reconciliation_runs WHERE "providerAccountId" = ${accountId}::uuid AND "forDate" = ${forDate}::date), 0) + 1,
                 ${trigger}::"ReconciliationTrigger", ${trigger === 'manual' ? (actor?.id ?? null) : null}::uuid
          RETURNING id::text AS id`;
        if (trigger === 'manual' && actor) {
          await this.audit.record(tx, { actor, action: 'payments.reconciliation.run', entityType: 'ProviderAccount', entityId: accountId, context: { runId: row!.id, forDate } });
        }
        return row!.id;
      });
    } catch (err) {
      // 23505: a run of this account is running, or another one took the attempt number at the same moment.
      const code = (err as { code?: string; meta?: { code?: string } }).meta?.code ?? (err as { code?: string }).code;
      if (code === '23505' || /23505|unique constraint/i.test(String((err as Error).message))) return null;
      throw err;
    }
  }

  private async close(runId: string, accountId: string, forDate: string, status: 'matched' | 'mismatch' | 'partial' | 'failed' | 'not_applicable', errorCode: string | null, checked: number, differences: Difference[]): Promise<RunView> {
    // Code review, minor 7: a difference that does not pass the schema never leaves the run open; it closes as failed.
    const parsed = differencesSchema.safeParse(differences.slice(0, 5000));
    if (!parsed.success) {
      status = 'failed';
      errorCode = 'invalid_differences';
    }
    const list = parsed.success ? parsed.data : [];
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE reconciliation_runs SET status = ${status}::"ReconciliationRunStatus", "errorCode" = ${errorCode}, "checkedObjects" = ${checked},
               differences = ${JSON.stringify(list)}::jsonb, "finishedAt" = now()
        WHERE id = ${runId}::uuid AND status = 'running'`;
      if (n === 0) return;
      for (const d of list) await this.tasks.createSystemIn(tx, this.differenceTask(accountId, d));
      if (status === 'failed') {
        await this.tasks.createSystemIn(tx, {
          title: 'Reconciliation could not run for a payment gateway account',
          description: `The daily reconciliation of this account stopped (${errorCode ?? 'error'}). It runs again tomorrow, or from the payments panel.`,
          entityType: 'ProviderAccount', entityId: accountId, sourceRef: `payments:reconciliation_failed:${accountId}`,
        });
      }
      if (list.length > 0) {
        await this.outbox.publish(tx, { type: PAYMENT_EVENTS.reconciliationMismatch, aggregateType: 'ReconciliationRun', aggregateId: runId, aggregateVersion: 0, payload: { runId, providerAccountId: accountId, forDate, count: list.length }, actorType: 'system' });
      }
    });
    return (await this.view(runId))!;
  }

  private differenceTask(accountId: string, d: Difference) {
    const entityType = TASK_ENTITY[d.entityType];
    const isUuid = /^[0-9a-f-]{36}$/.test(d.entityId);
    return {
      title: `Reconciliation: ${d.code.replace(/_/g, ' ')}`,
      description: `The daily reconciliation with the payment gateway found a difference (${d.code}) for ${d.entityType} ${d.entityId}. Nothing was changed: compare the app with the gateway's dashboard.`,
      entityType: entityType && isUuid ? entityType : 'ProviderAccount', entityId: entityType && isUuid ? d.entityId : accountId,
      sourceRef: reconciliationTaskRef(d.code, d.entityId),
    };
  }

  /** Gateway calls of one run: `retrieve` (allowed on paused, retired and archived accounts; never health), with a cut-off. */
  private caller(accountId: string): GatewayCaller {
    let failures = 0;
    return async <T>(fn: (provider: PaymentProvider, ctx: ProviderContext) => Promise<T>): Promise<T> => {
      try {
        const out = await this.gateway.call(accountId, 'retrieve', fn);
        failures = 0;
        return out;
      } catch (err) {
        if (err instanceof ProviderError && CUT_OFF_CODES.has(err.code)) {
          failures += 1;
          if (failures >= CUT_OFF_AFTER) throw new CutOff(err.code);
        }
        throw err;
      }
    };
  }

  /** One object's lookup; a ProviderError other than a cut-off or bad credentials is counted and the run goes on. */
  private async tolerant<T>(fn: () => Promise<T>, errors: { n: number }): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CutOff || !(err instanceof ProviderError) || err.code === 'provider_auth_failed') throw err;
      errors.n += 1;
      return undefined;
    }
  }

  private async compareObjects(accountId: string, mode: Mode, call: GatewayCaller, w: { since: Date; settled: Date; maxObjects: number }) {
    const differences: Difference[] = [];
    const errors = { n: 0 };
    const payments = await this.prisma.payment.findMany({
      where: {
        providerAccountId: accountId, mode, providerPaymentRef: { not: null }, updatedAt: { lt: w.settled },
        OR: [{ status: 'succeeded', succeededAt: { gte: w.since } }, { status: { in: ['failed', 'expired', 'cancelled'] }, updatedAt: { gte: w.since } }],
      },
      select: { id: true }, orderBy: { updatedAt: 'asc' }, take: w.maxObjects + 1,
    });
    const capped = payments.length > w.maxObjects;
    let checked = 0;
    for (const { id } of payments.slice(0, w.maxObjects)) {
      checked += 1;
      const first = await this.tolerant(() => this.paymentDifference(id, call), errors);
      // A difference is checked again once, our row re-read: only one that persists counts (plan 4.6, 2.3).
      const d = first ? await this.tolerant(() => this.paymentDifference(id, call), errors) : null;
      if (d) differences.push(d);
    }
    const left = Math.max(0, w.maxObjects - checked);
    const refunds = await this.prisma.refund.findMany({
      where: {
        providerAccountId: accountId, mode, providerRefundRef: { not: null }, manualRefund: false, updatedAt: { lt: w.settled, gte: w.since },
        // Review R12 (e): a refund 4.5 keeps as late_pending is followed by its own sweep and task.
        OR: [{ status: { in: ['succeeded', 'pending'] } }, { status: 'failed', failureCode: null }, { status: 'failed', failureCode: { not: LATE_PENDING_CODE } }],
      },
      select: { id: true }, orderBy: { updatedAt: 'asc' }, take: left + 1,
    });
    for (const { id } of refunds.slice(0, left)) {
      checked += 1;
      const first = await this.tolerant(() => this.refundDifference(id, call), errors);
      const d = first ? await this.tolerant(() => this.refundDifference(id, call), errors) : null;
      if (d) differences.push(d);
    }
    const closed = await this.prisma.dispute.findMany({
      where: { providerAccountId: accountId, mode, status: { in: ['won', 'lost', 'closed'] }, updatedAt: { lt: w.settled, gte: w.since } },
      select: { id: true, providerDisputeRef: true, status: true, amountMinor: true, currency: true, fundsWithdrawnAt: true, fundsReinstatedAt: true }, take: 500,
    });
    for (const d of closed) {
      checked += 1;
      const r = await this.tolerant(() => call(async (p, ctx) => (p.retrieveDispute ? p.retrieveDispute(ctx, d.providerDisputeRef) : null)), errors);
      if (r === undefined) continue;
      if (r === null) differences.push({ code: 'dispute_unknown_at_gateway', entityType: 'Dispute', entityId: d.id, ours: moneySide(d.amountMinor, d.currency, d.status) });
      else if (r.status !== d.status) differences.push({ code: 'dispute_status_differs', entityType: 'Dispute', entityId: d.id, ours: moneySide(d.amountMinor, d.currency, d.status), gateway: moneySide(r.amount.amountMinor, r.amount.currency, r.status) });
      else if (r.fundsWithdrawn !== (d.fundsWithdrawnAt !== null) || r.fundsReinstated !== (d.fundsReinstatedAt !== null)) differences.push({ code: 'dispute_funds_differ', entityType: 'Dispute', entityId: d.id, ours: moneySide(d.amountMinor, d.currency, d.status), gateway: moneySide(r.amount.amountMinor, r.amount.currency, r.status) });
    }
    return { differences, checked, capped: capped || refunds.length > left, errors: errors.n };
  }

  private async paymentDifference(id: string, call: GatewayCaller): Promise<Difference | null> {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, amountMinor: true, currency: true, providerPaymentRef: true } });
    const ours = moneySide(p.amountMinor, p.currency, p.status);
    const r = await call((provider, ctx) => provider.retrievePayment(ctx, { ref: p.providerPaymentRef! }));
    if (!r) return p.status === 'succeeded' ? { code: 'payment_missing_at_gateway', entityType: 'Payment', entityId: id, ours } : null;
    const gateway = moneySide(r.amount.amountMinor, r.amount.currency, r.status);
    if ((p.status === 'succeeded') !== (r.status === 'succeeded')) return { code: 'payment_status_differs', entityType: 'Payment', entityId: id, ours, gateway };
    if (r.amount.amountMinor !== p.amountMinor || r.amount.currency !== p.currency) return { code: 'payment_amount_differs', entityType: 'Payment', entityId: id, ours, gateway };
    return null;
  }

  private async refundDifference(id: string, call: GatewayCaller): Promise<Difference | null> {
    const r = await this.prisma.refund.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, amountMinor: true, currency: true, providerRefundRef: true, payment: { select: { providerPaymentRef: true } } } });
    const ours = moneySide(r.amountMinor, r.currency, r.status);
    const g = await call((provider, ctx) => provider.retrieveRefund(ctx, { ref: r.providerRefundRef! }));
    if (!g) return r.status === 'succeeded' ? { code: 'refund_missing_at_gateway', entityType: 'Refund', entityId: id, ours } : null;
    const gateway = moneySide(g.amount.amountMinor, g.amount.currency, g.status);
    const same = r.status === 'succeeded' ? g.status === 'succeeded' : r.status === 'pending' ? g.status === 'pending' : g.status === 'failed' || g.status === 'cancelled';
    if (!same) return { code: 'refund_status_differs', entityType: 'Refund', entityId: id, ours, gateway };
    if (g.amount.amountMinor !== r.amountMinor || g.amount.currency !== r.currency) return { code: 'refund_amount_differs', entityType: 'Refund', entityId: id, ours, gateway };
    return null;
  }

  private async compareActivity(accountId: string, mode: Mode, call: GatewayCaller, w: { since: Date; settled: Date; forDate: string; runId: string }) {
    const differences: Difference[] = [];
    let checked = 0;
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 500; pageNo++) {
      const page = await call((p, ctx) => p.listActivity!(ctx, { from: w.since, to: w.settled, ...(cursor ? { cursor } : {}) }));
      for (const item of page.items) {
        checked += 1;
        const d = await this.activityDifference(accountId, mode, item, call, w);
        if (d) differences.push(d);
      }
      if (!page.next) break;
      cursor = page.next;
    }
    return { differences, checked };
  }

  private async activityDifference(accountId: string, mode: Mode, item: ProviderActivity, call: GatewayCaller, w: { forDate: string; runId: string }): Promise<Difference | null> {
    // Code review, minor 6: an item whose reference we cannot store is reported under a stand-in id, never ignored.
    if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(item.ref)) {
      const code = item.kind === 'payment' ? 'unknown_gateway_payment' : item.kind === 'refund' ? 'unknown_gateway_refund' : 'unknown_gateway_dispute';
      return { code, entityType: 'GatewayObject', entityId: `invalid_ref:${createHash('sha256').update(String(item.ref)).digest('hex').slice(0, 32)}` };
    }
    const gateway = moneySide(item.amount.amountMinor, /^[A-Z]{3}$/.test(item.amount.currency) ? item.amount.currency : undefined, /^[a-z_]{1,40}$/.test(item.status) ? item.status : undefined);
    const ourId = item.ourId && /^[0-9a-f-]{36}$/.test(item.ourId) ? item.ourId : null;
    if (item.kind === 'payment') {
      if (item.status !== 'succeeded') return null;
      const ours = await this.prisma.payment.findFirst({
        where: { providerAccountId: accountId, mode, OR: [...(ourId ? [{ id: ourId }] : []), { providerPaymentRef: item.ref }] },
        select: { id: true, status: true, amountMinor: true, currency: true },
      });
      if (!ours) return { code: 'unknown_gateway_payment', entityType: 'GatewayObject', entityId: item.ref, gateway };
      if (ours.amountMinor !== item.amount.amountMinor || ours.currency !== item.amount.currency) return { code: 'gateway_amount_differs', entityType: 'Payment', entityId: ours.id, ours: moneySide(ours.amountMinor, ours.currency, ours.status), gateway };
      if (ours.status !== 'succeeded' && ours.status !== 'voided') return { code: 'payment_status_differs', entityType: 'Payment', entityId: ours.id, ours: moneySide(ours.amountMinor, ours.currency, ours.status), gateway };
      return null;
    }
    if (item.kind === 'refund') {
      if (item.status !== 'succeeded' && item.status !== 'pending') return null;
      const ours = await this.prisma.refund.findFirst({
        where: { providerAccountId: accountId, mode, OR: [...(ourId ? [{ id: ourId }] : []), { providerRefundRef: item.ref }] },
        select: { id: true, status: true, amountMinor: true, currency: true },
      });
      if (ours) {
        if (ours.amountMinor !== item.amount.amountMinor || ours.currency !== item.amount.currency) return { code: 'gateway_amount_differs', entityType: 'Refund', entityId: ours.id, ours: moneySide(ours.amountMinor, ours.currency, ours.status), gateway };
        // Code review M2: money went out at the gateway for a refund we hold as not done (failed, requested…).
        if ((item.status === 'succeeded' && ours.status !== 'succeeded' && ours.status !== 'pending' && ours.status !== 'reversed')
          || (item.status === 'pending' && ours.status === 'failed')) return { code: 'refund_status_differs', entityType: 'Refund', entityId: ours.id, ours: moneySide(ours.amountMinor, ours.currency, ours.status), gateway };
        return null;
      }
      // Review R9 and code review M3: money went out of one of our payments without us. The first time this refund is
      // seen (no task about it yet, open or closed), its booking is put under review as after any money out, with the
      // booking locked and audited; once Oscar closes that review, a later run does not block the booking again.
      const payment = item.paymentRef ? await this.prisma.payment.findFirst({ where: { providerAccountId: accountId, mode, providerPaymentRef: item.paymentRef }, select: { bookingId: true } }) : null;
      const seenBefore = (await this.prisma.task.count({ where: { sourceRef: reconciliationTaskRef('unknown_gateway_refund', item.ref) } })) > 0;
      if (payment && !seenBefore) {
        await runTransaction(this.prisma, async (tx) => {
          const b = await readBookingForPayments(tx, { id: payment.bookingId }, true);
          if (!b) return;
          await this.refunds.afterMoneyOut(tx, b, {}, undefined, { forceReview: true });
          // Round 2 review: the difference's task is the record that this refund was handled; written with the review,
          // so a run that fails before closing never puts a booking Oscar already cleared under review again.
          await this.tasks.createSystemIn(tx, this.differenceTask(accountId, { code: 'unknown_gateway_refund', entityType: 'GatewayObject', entityId: item.ref }));
        }, PAYMENT_TX_OPTIONS);
      }
      return { code: 'unknown_gateway_refund', entityType: 'GatewayObject', entityId: item.ref, gateway };
    }
    const known = await this.prisma.dispute.findFirst({ where: { providerAccountId: accountId, providerDisputeRef: item.ref }, select: { id: true } });
    if (known) return null;
    // Review R9: a dispute of one of our payments is registered as its webhook would have.
    const remote = await call(async (p, ctx) => (p.retrieveDispute ? p.retrieveDispute(ctx, item.ref) : null));
    if (remote) {
      const out = await this.disputes.apply(accountId, remote, `sweep:new:${w.forDate}:${w.runId}`);
      if (out === 'applied') return null;
    }
    return { code: 'unknown_gateway_dispute', entityType: 'GatewayObject', entityId: item.ref, gateway };
  }

  private async internal(accountId: string, mode: Mode, w: { settled: Date; since: Date; graceDays: number | null; now: Date }): Promise<Difference[]> {
    const out: Difference[] = [];
    // Review R12 (d): only payments that have their ledger posting can be missing a receipt.
    const noReceipt = await this.prisma.$queryRaw<Array<{ id: string; amountMinor: bigint; currency: string }>>`
      SELECT p.id::text AS id, p."amountMinor", p.currency FROM payments p JOIN ledger_transactions t ON t."idempotencyKey" = 'payment:' || p.id::text || ':succeeded'
      WHERE p."providerAccountId" = ${accountId}::uuid AND p.mode = ${mode}::"PaymentMode" AND t."occurredAt" < ${w.settled}
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r."paymentId" = p.id)
      ORDER BY p.id LIMIT 500`;
    for (const r of noReceipt) out.push({ code: 'receipt_missing', entityType: 'Payment', entityId: r.id, ours: moneySide(r.amountMinor, r.currency, 'succeeded') });
    if (w.graceDays !== null) {
      const cutoff = new Date(w.now.getTime() - w.graceDays * DAY);
      const unsettled = await this.prisma.$queryRaw<Array<{ id: string; kind: string; amountMinor: bigint; currency: string }>>`
        SELECT p.id::text AS id, 'Payment' AS kind, p."amountMinor", p.currency FROM payments p
        WHERE p."providerAccountId" = ${accountId}::uuid AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded' AND p."succeededAt" < ${cutoff} AND p."succeededAt" >= ${w.since}
          AND NOT EXISTS (SELECT 1 FROM settlement_line_matches m WHERE m."paymentId" = p.id)
        UNION ALL
        SELECT r.id::text, 'Refund', r."amountMinor", r.currency FROM refunds r
        WHERE r."providerAccountId" = ${accountId}::uuid AND r.mode = ${mode}::"PaymentMode" AND r.status = 'succeeded' AND r."succeededAt" < ${cutoff} AND r."succeededAt" >= ${w.since} AND NOT r."manualRefund"
          AND NOT EXISTS (SELECT 1 FROM settlement_line_matches m WHERE m."refundId" = r.id)
        ORDER BY 1 LIMIT 500`;
      for (const u of unsettled) out.push({ code: 'not_settled_in_time', entityType: u.kind as 'Payment' | 'Refund', entityId: u.id, ours: moneySide(u.amountMinor, u.currency) });
    }
    return out;
  }

  /** An account with no matched or partial run in the last 48 h gets a task (plan 4.6, 2.4). */
  async overdue(now: Date, accounts: Array<{ id: string; createdAt: Date }>): Promise<void> {
    for (const a of accounts) {
      if (a.createdAt.getTime() > now.getTime() - 2 * DAY) continue;
      const adapter = await this.prisma.providerAccount.findUnique({ where: { id: a.id }, select: { adapterKey: true } });
      if (!adapter || NO_GATEWAY.has(adapter.adapterKey)) continue;
      const ok = await this.prisma.reconciliationRun.count({ where: { providerAccountId: a.id, status: { in: ['matched', 'partial', 'mismatch', 'not_applicable'] }, startedAt: { gt: new Date(now.getTime() - 2 * DAY) } } });
      if (ok > 0) continue;
      await this.prisma.$transaction((tx) => this.tasks.createSystemIn(tx, {
        title: 'Reconciliation overdue for a payment gateway account',
        description: 'This gateway account has not been reconciled for two days. Run the reconciliation from the payments panel and check why the daily run fails.',
        entityType: 'ProviderAccount', entityId: a.id, sourceRef: `payments:reconciliation_overdue:${a.id}`,
      }));
    }
  }

  async view(runId: string): Promise<RunView | null> {
    const r = await this.prisma.reconciliationRun.findUnique({ where: { id: runId } });
    if (!r) return null;
    return {
      id: r.id, providerAccountId: r.providerAccountId, forDate: r.forDate.toISOString().slice(0, 10), attempt: r.attempt, trigger: r.trigger, status: r.status,
      errorCode: r.errorCode, checkedObjects: r.checkedObjects, differences: differencesSchema.parse(r.differences), startedAt: r.startedAt, finishedAt: r.finishedAt,
    };
  }

  async list(opts: { accountId?: string; limit?: number } = {}): Promise<Array<Omit<RunView, 'differences'> & { differenceCount: number; accountName: string }>> {
    const rows = await this.prisma.reconciliationRun.findMany({
      where: { mode: this.gateway.mode, ...(opts.accountId ? { providerAccountId: opts.accountId } : {}) },
      orderBy: [{ startedAt: 'desc' }], take: Math.min(opts.limit ?? 60, 200),
      include: { account: { select: { displayName: true } } },
    });
    return rows.map((r) => ({
      id: r.id, providerAccountId: r.providerAccountId, accountName: r.account.displayName, forDate: r.forDate.toISOString().slice(0, 10), attempt: r.attempt, trigger: r.trigger, status: r.status,
      errorCode: r.errorCode, checkedObjects: r.checkedObjects, differenceCount: Array.isArray(r.differences) ? r.differences.length : 0, startedAt: r.startedAt, finishedAt: r.finishedAt,
    }));
  }
}
