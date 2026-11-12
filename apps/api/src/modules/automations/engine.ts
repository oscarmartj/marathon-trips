import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTOMATION_STEP_CODES, MAX_REAL_RUNS_PER_HOUR, automationFactsSchema, automationRuleDefinitionSchema, automationScheduleSchema, triggerOf,
} from '@mt/shared';
import type { AutomationFacts, AutomationReasonCode, AutomationRuleDefinition, AutomationStep, AutomationStepCode } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../../platform/access/access.service';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { bossDb } from '../../platform/database/boss-db';
import { PrismaService } from '../../platform/database/prisma.service';
import { AppError, safeError } from '../../platform/errors/safe-error';
import type { DeliveredEvent } from '../../platform/events/consumers';
import { OutboxService } from '../../platform/events/outbox.service';
import { FeatureFlagService } from '../../platform/flags/flags.service';
import { notFound } from '../../platform/http/api-error';
import { JobsService } from '../../platform/jobs/jobs.service';
import { QUEUES } from '../../platform/jobs/queues';
import { AutomationActions } from './actions';
import { evaluateConditions } from './conditions';
import { factsOf, loadEntity } from './facts';
import type { LoadedEntity } from './facts';
import { AUTOMATION_EVENTS, AUTOMATIONS_MODULE, AUTOMATIONS_TIME_ZONE } from './manifest';
import { scopeOf } from './rules.service';
import { SCHEDULE_GRACE_MS, latestOccurrence, localDate } from './schedule';

type Tx = Prisma.TransactionClient;
type RuleRow = Prisma.AutomationRuleGetPayload<object>;
type RunRow = Prisma.AutomationRunGetPayload<object>;

/** A notice about something this old is worse than none: such events are logged as skipped, never acted on. */
export const MAX_EVENT_AGE_MS = 48 * 3_600_000;
/** pg-boss tries a run this many times; the last failure is final. */
export const MAX_RUN_ATTEMPTS = 3;
/** A run still pending after this long is marked failed by the maintenance job. */
export const STALE_AFTER_MS = 6 * 3_600_000;
export const RUN_RETENTION_DAYS = 90;
const STEP_CODES: ReadonlySet<string> = new Set(AUTOMATION_STEP_CODES);

export interface Outcome {
  status: 'succeeded' | 'skipped' | 'failed';
  reasonCode: AutomationReasonCode | null;
  steps: AutomationStep[];
  testMode: boolean;
  ruleVersion: number;
  conditions: boolean[];
}

/** A failure with a code from the closed list, rolled back and recorded (never retried). */
class RunStop extends AppError {
  constructor(readonly reason: AutomationReasonCode) {
    super(reason, 'The automation run stopped');
  }
}

/**
 * Runs automations (task 7.4): the outbox consumer that starts runs for events, the schedule tick, the run job and
 * the panel's test. A run happens in one transaction: every action or none. Test mode records what would happen and
 * writes nothing else, and a panel test is always a test (a CHECK in the database).
 */
@Injectable()
export class AutomationEngine {
  private readonly logger = new Logger('Automations');
  /** Test seam: called before each action runs (index), inside the run's transaction. */
  beforeAction: ((index: number) => Promise<void> | void) | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AutomationActions) private readonly actions: AutomationActions,
  ) {}

  // ---------------------------------------------------------------- dispatch

  /**
   * The outbox consumer. In the delivery's transaction: one run per enabled rule for this event type that was on
   * before the event happened, with the facts read now, and its job. Events caused by an automation never start a run.
   */
  async onEvent(event: DeliveredEvent, tx: Tx, now: Date = new Date()): Promise<number> {
    const trigger = triggerOf(event.type);
    if (!trigger || event.actorType === 'automation') return 0;
    const rules = await tx.automationRule.findMany({
      where: { enabled: true, deletedAt: null, triggerType: 'event', eventType: event.type, enabledAt: { lte: event.occurredAt } },
      select: { id: true, version: true, testMode: true }, orderBy: { id: 'asc' },
    });
    if (rules.length === 0) return 0;
    const entity = await loadEntity(tx, trigger.entityType, event.aggregateId);
    const facts = entity ? factsOf(event.type, entity, { actorType: event.actorType, payload: event.payload }) : null;
    const tooOld = now.getTime() - event.occurredAt.getTime() > MAX_EVENT_AGE_MS;
    let created = 0;
    for (const rule of rules) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO automation_runs (id, "ruleId", "ruleVersion", source, "triggerEventId", "triggerEventType", "entityType", "entityId", facts, "testMode", status, "reasonCode", "finishedAt")
        VALUES (gen_random_uuid(), ${rule.id}::uuid, ${rule.version}, 'event', ${event.id}::uuid, ${event.type}, ${trigger.entityType}, ${event.aggregateId}::uuid,
          ${facts ? JSON.stringify(facts) : null}::jsonb, ${rule.testMode},
          ${tooOld ? 'skipped' : 'pending'}::"AutomationRunStatus", ${tooOld ? 'event_too_old' : null}, ${tooOld ? now : null}::timestamptz)
        ON CONFLICT ("ruleId", "triggerEventId", "scheduledFor") WHERE source <> 'manual' DO NOTHING
        RETURNING id`;
      for (const r of rows) {
        created += 1;
        if (!tooOld) await this.jobs.send(QUEUES.automationsRun, { runId: r.id }, { db: bossDb(tx), singletonKey: r.id });
      }
    }
    return created;
  }

  /** The schedule tick: the latest occurrence of each scheduled rule, once per rule and local date, never a backlog. */
  async tick(now: Date = new Date(), timeZone = AUTOMATIONS_TIME_ZONE): Promise<number> {
    if (!(await this.flags.isModuleEnabled(AUTOMATIONS_MODULE))) return 0;
    const rules = await this.prisma.automationRule.findMany({ where: { enabled: true, deletedAt: null, triggerType: 'schedule' }, select: { id: true } });
    let created = 0;
    for (const { id } of rules) {
      created += await this.prisma.$transaction(async (tx) => {
        const rule = await tx.automationRule.findUnique({ where: { id } });
        if (!rule || !rule.enabled || rule.deletedAt || rule.triggerType !== 'schedule' || !rule.enabledAt) return 0;
        const schedule = automationScheduleSchema.safeParse(rule.schedule);
        if (!schedule.success) return 0;
        const at = latestOccurrence(schedule.data, now, timeZone);
        if (!at || at < rule.enabledAt || now.getTime() - at.getTime() > SCHEDULE_GRACE_MS) return 0;
        const last = await tx.automationRun.findFirst({ where: { ruleId: id, source: 'schedule' }, orderBy: { scheduledFor: 'desc' }, select: { scheduledFor: true } });
        if (last?.scheduledFor && (last.scheduledFor >= at || localDate(last.scheduledFor, timeZone) === localDate(at, timeZone))) return 0;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO automation_runs (id, "ruleId", "ruleVersion", source, "scheduledFor", "testMode")
          VALUES (gen_random_uuid(), ${id}::uuid, ${rule.version}, 'schedule', ${at}::timestamptz, ${rule.testMode})
          ON CONFLICT ("ruleId", "triggerEventId", "scheduledFor") WHERE source <> 'manual' DO NOTHING
          RETURNING id`;
        for (const r of rows) await this.jobs.send(QUEUES.automationsRun, { runId: r.id }, { db: bossDb(tx), singletonKey: r.id });
        return rows.length;
      });
    }
    return created;
  }

  // ---------------------------------------------------------------- the run job

  /**
   * The `automations.run` job. Only a `pending` run is processed and its row is locked, so a repeated job does
   * nothing. A known stop rolls back and is recorded at once; any other error rolls back, keeps the run pending and
   * lets pg-boss retry, until the last attempt marks it failed.
   */
  async processRun(runId: string, now: Date = new Date()): Promise<'noop' | Outcome['status'] | 'retry'> {
    const steps: AutomationStep[] = [];
    let attemptsBefore = 0;
    let started = false;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM automation_runs WHERE id = ${runId}::uuid AND status = 'pending' FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return 'noop' as const;
        const run = await tx.automationRun.findUniqueOrThrow({ where: { id: runId } });
        attemptsBefore = run.attempts;
        started = true;
        const out = await this.execute(tx, run, now, steps);
        await tx.automationRun.update({
          where: { id: runId },
          data: { status: out.status, reasonCode: out.reasonCode, steps: out.steps as unknown as Prisma.InputJsonValue, ruleVersion: out.ruleVersion, testMode: out.testMode, finishedAt: now, attempts: { increment: 1 } },
        });
        if (!out.testMode && out.status !== 'skipped') {
          await this.outbox.publish(tx, {
            type: AUTOMATION_EVENTS.runCompleted, aggregateType: 'AutomationRun', aggregateId: runId, payload: { runId, ruleId: run.ruleId, status: out.status },
            actorType: 'automation', actorId: run.ruleId,
          });
        }
        return out.status;
      });
    } catch (err) {
      if (!started) throw err;
      const stop = err instanceof RunStop ? err.reason : null;
      const known = stop !== null || err instanceof AppError;
      const attempts = attemptsBefore + 1;
      const final = known || attempts >= MAX_RUN_ATTEMPTS;
      const code: AutomationStepCode = known ? 'action_failed' : 'transient_error';
      // What ran before the failure was rolled back with it; the failing step carries a code, never the message.
      const recorded: AutomationStep[] = steps.map((s) => (s.status === 'failed' ? s : { index: s.index, action: s.action, status: 'rolled_back' as const }));
      await this.prisma.automationRun.updateMany({
        where: { id: runId, status: 'pending' },
        data: final
          ? { status: 'failed', reasonCode: stop ?? (known ? 'action_failed' : 'transient_error'), steps: recorded as unknown as Prisma.InputJsonValue, attempts, finishedAt: new Date() }
          : { attempts, steps: recorded as unknown as Prisma.InputJsonValue },
      });
      this.logger.warn(`automation run ${runId} failed (${code}): ${safeError(err).code}`);
      if (final) return 'failed';
      throw err; // pg-boss retries with backoff
    }
  }

  /** The panel's test: the same checks and steps, always in test mode, recorded as a manual run. */
  async test(ruleId: string, entityId: string | undefined, now: Date = new Date()): Promise<Outcome & { runId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.automationRule.findUnique({ where: { id: ruleId } });
      if (!rule || rule.deletedAt) throw notFound('automation_not_found', 'Automation not found');
      const trigger = rule.triggerType === 'event' && rule.eventType ? triggerOf(rule.eventType) : undefined;
      if (trigger && !entityId) throw notFound('automation_test_record_missing', 'Give the id of a record to test with');
      const entity = trigger && entityId ? await loadEntity(tx, trigger.entityType, entityId) : null;
      if (trigger && !entity) throw notFound('automation_test_record_missing', 'No record with that id');
      const run = await tx.automationRun.create({
        data: {
          ruleId, ruleVersion: rule.version, source: 'manual', testMode: true, triggerEventType: rule.eventType, entityType: entity?.entityType ?? null, entityId: entity?.id ?? null,
          facts: entity && rule.eventType ? (factsOf(rule.eventType, entity) as Prisma.InputJsonValue) : undefined,
        },
      });
      const steps: AutomationStep[] = [];
      let out: Outcome;
      try {
        out = await this.execute(tx, run, now, steps);
      } catch (err) {
        // A test never retries: the run is recorded as failed with a code.
        out = { status: 'failed', reasonCode: err instanceof RunStop ? err.reason : 'action_failed', steps, testMode: true, ruleVersion: rule.version, conditions: [] };
      }
      await tx.automationRun.update({
        where: { id: run.id },
        data: { status: out.status, reasonCode: out.reasonCode, steps: out.steps as unknown as Prisma.InputJsonValue, ruleVersion: out.ruleVersion, finishedAt: now, attempts: 1 },
      });
      return { ...out, testMode: true, runId: run.id };
    });
  }

  // ---------------------------------------------------------------- one run

  private async execute(tx: Tx, run: RunRow, now: Date, steps: AutomationStep[]): Promise<Outcome> {
    const manual = run.source === 'manual';
    const stop = (status: 'skipped' | 'failed', reasonCode: AutomationReasonCode, ruleVersion = run.ruleVersion, testMode = run.testMode): Outcome =>
      ({ status, reasonCode, steps: [], testMode, ruleVersion, conditions: [] });

    if (!manual && !(await this.flags.isModuleEnabled(AUTOMATIONS_MODULE, tx))) return stop('skipped', 'module_disabled');
    // FOR SHARE: an edit of the rule waits for this run (and a run waits for an edit in progress).
    await tx.$queryRaw`SELECT id FROM automation_rules WHERE id = ${run.ruleId}::uuid FOR SHARE`;
    const rule = await tx.automationRule.findUniqueOrThrow({ where: { id: run.ruleId } });
    // Test if the run started as a test or the rule is a test now: a test never turns into the real thing.
    const testMode = manual || run.testMode || rule.testMode;
    if (!manual && (rule.deletedAt || !rule.enabled)) return stop('skipped', 'rule_disabled', rule.version, testMode);
    const parsed = automationRuleDefinitionSchema.safeParse({
      name: rule.name, triggerType: rule.triggerType, eventType: rule.eventType ?? undefined, schedule: rule.schedule ?? undefined, conditions: rule.conditions, actions: rule.actions,
    });
    if (!parsed.success) return stop('failed', 'rule_invalid', rule.version, testMode);
    const def = parsed.data;
    if (!manual && !this.sameTrigger(run, def)) return stop('skipped', 'rule_changed', rule.version, testMode);
    const scope = scopeOf(def);

    // The owner's current permissions, read after locking the owner's row against a concurrent role change.
    const owner = await tx.$queryRaw<Array<{ status: string; kind: string }>>`SELECT status::text AS status, kind::text AS kind FROM users WHERE id = ${rule.ownerUserId}::uuid FOR SHARE`;
    if (owner[0]?.status !== 'active' || owner[0]?.kind !== 'staff') {
      if (!testMode) await this.notify(tx, rule, 'owner_inactive', 'An automation is paused because its owner can no longer sign in');
      return stop('skipped', 'owner_inactive', rule.version, testMode);
    }
    const eff = await this.access.effective(tx, rule.ownerUserId);
    let needed: string[];
    try {
      needed = [...new Set(def.actions.flatMap((a) => this.actions.registry.permissionsOf(a, scope)))];
    } catch {
      return stop('failed', 'rule_invalid', rule.version, testMode);
    }
    if (needed.some((k) => !eff.keys.has(k))) {
      if (!testMode) await this.notify(tx, rule, 'permission_lost', 'An automation cannot run because its owner lost a permission it needs');
      return stop('failed', 'automation_cannot_exceed_author_permissions', rule.version, testMode);
    }
    if (!testMode) {
      const recent = await tx.automationRun.count({ where: { ruleId: rule.id, testMode: false, source: { not: 'manual' }, status: { in: ['succeeded', 'failed'] }, startedAt: { gt: new Date(now.getTime() - 3_600_000) } } });
      if (recent >= MAX_REAL_RUNS_PER_HOUR) {
        await this.notify(tx, rule, 'rate_limited', 'An automation ran too often in the last hour and was held back');
        return stop('skipped', 'rate_limited', rule.version, testMode);
      }
    }

    // The record and the facts. Facts are the snapshot taken at dispatch (all rules of one event see the same ones).
    let entity: LoadedEntity | null = null;
    let facts: AutomationFacts = {};
    if (scope !== 'schedule') {
      if (!run.entityType || !run.entityId || run.entityType !== scope) return stop('skipped', 'rule_changed', rule.version, testMode);
      entity = await loadEntity(tx, scope, run.entityId);
      const snap = automationFactsSchema.safeParse(run.facts);
      if (!entity || !snap.success || run.facts === null) return stop('skipped', 'entity_gone', rule.version, testMode);
      facts = snap.data;
    }
    const conditions = evaluateConditions(def.conditions, facts);
    if (conditions.some((c) => !c)) return { ...stop('skipped', 'conditions_not_met', rule.version, testMode), conditions };

    const actor = { type: 'automation' as const, id: rule.id };
    for (const [index, action] of def.actions.entries()) {
      if (this.beforeAction) await this.beforeAction(index);
      const d = this.actions.registry.get(action.type);
      try {
        const r = await d.run(action as never, {
          tx, testMode, rule: { id: rule.id, name: rule.name, ownerUserId: rule.ownerUserId },
          run: { id: run.id, triggerEventType: run.triggerEventType, scheduledFor: run.scheduledFor }, index, entity, actor, now,
        });
        if (r.code && !STEP_CODES.has(r.code)) throw new AppError('automation_step_code_unknown', 'An action returned an unknown code');
        steps.push({ index, action: action.type, ...r });
      } catch (err) {
        steps.push({ index, action: action.type, status: 'failed', code: err instanceof AppError ? 'action_failed' : 'transient_error' });
        throw err;
      }
    }
    return { status: 'succeeded', reasonCode: null, steps: [...steps], testMode, ruleVersion: rule.version, conditions };
  }

  private sameTrigger(run: RunRow, def: AutomationRuleDefinition): boolean {
    if (run.source === 'event') return def.triggerType === 'event' && def.eventType === run.triggerEventType;
    if (run.source === 'schedule') return def.triggerType === 'schedule';
    return true;
  }

  /** One open system task per rule and reason (real runs only): Oscar sees the automation needs him. */
  private async notify(tx: Tx, rule: RuleRow, reason: 'owner_inactive' | 'permission_lost' | 'rate_limited', title: string): Promise<void> {
    await this.tasks.createSystemIn(tx, { title, entityType: 'AutomationRule', entityId: rule.id, sourceRef: `automations:${reason}:${rule.id}` });
  }

  // ---------------------------------------------------------------- maintenance

  /** Fails runs stuck in pending and purges runs older than 90 days. */
  async maintenance(now: Date = new Date()): Promise<{ stale: number; purged: number }> {
    const stale = await this.prisma.automationRun.updateMany({
      where: { status: 'pending', startedAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
      data: { status: 'failed', reasonCode: 'stale', finishedAt: now },
    });
    const purged = await this.prisma.automationRun.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - RUN_RETENTION_DAYS * 24 * 3_600_000) }, status: { not: 'pending' } } });
    return { stale: stale.count, purged: purged.count };
  }
}
