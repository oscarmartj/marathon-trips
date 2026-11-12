import { Inject, Injectable } from '@nestjs/common';
import {
  AUTOMATION_EVENT_TRIGGERS, MAX_ENABLED_RULES, automationRuleDefinitionSchema, isCustomerTemplate, triggerOf,
} from '@mt/shared';
import type { AutomationRuleDefinition, AutomationEntityType } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../../platform/access/access.service';
import type { AuthContext } from '../../platform/access/auth-context';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../platform/http/api-error';
import { existingCatalogueIds } from '../catalogue';
import { AutomationActions } from './actions';
import { checkConditions, referencedIds } from './conditions';
import { AUTOMATIONS_PERMISSIONS as P } from './manifest';

type Tx = Prisma.TransactionClient;
type Scope = AutomationEntityType | 'schedule';
export interface Caller {
  auth: AuthContext;
  actor: AuditActor & { id: string };
}

type RuleRow = Prisma.AutomationRuleGetPayload<object>;

/** The definition fields of a stored rule, as one object (what the panel edits and the audit compares). */
const definitionOf = (r: RuleRow) => ({
  name: r.name, triggerType: r.triggerType, eventType: r.eventType ?? undefined, schedule: (r.schedule ?? undefined) as AutomationRuleDefinition['schedule'],
  conditions: r.conditions as AutomationRuleDefinition['conditions'], actions: r.actions as AutomationRuleDefinition['actions'],
});
const audited = (r: RuleRow) => ({
  name: r.name, triggerType: r.triggerType, eventType: r.eventType, schedule: r.schedule, conditions: r.conditions, actions: r.actions,
  enabled: r.enabled, testMode: r.testMode, ownerUserId: r.ownerUserId, deletedAt: r.deletedAt,
});

export const scopeOf = (d: Pick<AutomationRuleDefinition, 'triggerType' | 'eventType'>): Scope =>
  d.triggerType === 'schedule' || !d.eventType ? 'schedule' : (triggerOf(d.eventType)?.entityType ?? 'schedule');

/** Rules: create, change, switch on and off, delete; and the checks that keep a rule within its owner's permissions. */
@Injectable()
export class AutomationRulesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AutomationActions) private readonly actions: AutomationActions,
  ) {}

  /** The panel's form data: triggers with their facts, and actions with where they may be used and what they need. */
  catalogue() {
    return {
      triggers: Object.entries(AUTOMATION_EVENT_TRIGGERS).map(([eventType, t]) => ({ eventType, entityType: t.entityType, facts: Object.entries(t.facts).map(([key, kind]) => ({ key, ...kind })) })),
      actions: this.actions.registry.all().map((a) => ({ type: a.type, allowedOn: a.allowedOn, permissions: a.declaredPermissions })),
    };
  }

  /** Every permission the rule's actions ask of its owner. */
  permissionsFor(def: AutomationRuleDefinition): string[] {
    const scope = scopeOf(def);
    return [...new Set(def.actions.flatMap((a) => this.actions.registry.permissionsOf(a, scope)))].sort();
  }

  /**
   * Checks a definition against the database and the caller: facts and values, referenced records, where each action
   * may be used, one customer email at most, no webhook twice, and that the caller holds every permission the actions
   * need (with a recent TOTP check where a permission asks for one).
   */
  async validate(tx: Tx, caller: Caller, def: AutomationRuleDefinition, enabling: boolean): Promise<void> {
    checkConditions(def.triggerType === 'event' ? def.eventType ?? null : null, def.conditions);
    const refs = referencedIds(def.eventType ?? null, def.conditions);
    for (const ref of ['package', 'edition', 'race'] as const) {
      const wanted = [...new Set(refs[ref])];
      if (wanted.length && (await existingCatalogueIds(tx, ref, wanted)).size !== wanted.length) throw unprocessable('automation_condition_invalid', 'A condition names a record that does not exist');
    }
    if (refs.tag.length) {
      const wanted = [...new Set(refs.tag)];
      const tags = await tx.tag.findMany({ where: { id: { in: wanted } }, select: { entityTypes: true } });
      if (tags.length !== wanted.length || tags.some((t) => t.entityTypes.length > 0 && !t.entityTypes.includes('Booking'))) throw unprocessable('automation_tag_invalid', 'A condition names a tag that does not exist or cannot be used on bookings');
    }
    const scope = scopeOf(def);
    if (def.actions.filter((a) => a.type === 'send_email' && isCustomerTemplate(a.template)).length > 1) throw unprocessable('automation_too_many_customer_emails', 'An automation sends at most one email to the customer');
    const hooks = def.actions.flatMap((a) => (a.type === 'call_webhook' ? [a.subscriptionId] : []));
    if (new Set(hooks).size !== hooks.length) throw unprocessable('duplicate_webhook_action', 'Each webhook can be called once per automation');
    for (const a of def.actions) {
      const d = this.actions.registry.get(a.type);
      if (!d.allowedOn.includes(scope)) throw unprocessable('automation_action_not_allowed', 'One of the actions cannot be used with this trigger');
      await d.validate(a as never, { tx, scope, enabling });
    }
    for (const key of this.permissionsFor(def)) {
      try {
        await this.access.assertPermission(tx, caller.auth, key);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'forbidden') throw forbidden('automation_cannot_exceed_author_permissions', 'This automation would do something you are not allowed to do');
        throw e;
      }
    }
  }

  private async lockRule(tx: Tx, id: string): Promise<RuleRow> {
    await tx.$queryRaw`SELECT id FROM automation_rules WHERE id = ${id}::uuid FOR UPDATE`;
    const rule = await tx.automationRule.findUnique({ where: { id } });
    if (!rule || rule.deletedAt) throw notFound('automation_not_found', 'Automation not found');
    return rule;
  }

  private checkVersion(rule: RuleRow, version: number): void {
    if (rule.version !== version) throw conflict('version_conflict', 'Someone else changed this automation. Reload and try again.');
  }

  async create(caller: Caller, def: AutomationRuleDefinition) {
    return this.prisma.$transaction(async (tx) => {
      await this.validate(tx, caller, def, false);
      const rule = await tx.automationRule.create({
        data: {
          name: def.name, triggerType: def.triggerType, eventType: def.eventType ?? null, schedule: (def.schedule ?? undefined) as Prisma.InputJsonValue | undefined,
          conditions: def.conditions as Prisma.InputJsonValue, actions: def.actions as Prisma.InputJsonValue, ownerUserId: caller.actor.id,
        },
      });
      await this.audit.record(tx, { actor: caller.actor, action: 'automations.rule.created', entityType: 'AutomationRule', entityId: rule.id, model: 'AutomationRule', after: audited(rule) });
      return this.view(rule);
    });
  }

  /** Replaces the definition. A rule that is on needs the enable permission (step-up) and must pass every check. */
  async update(caller: Caller, id: string, input: AutomationRuleDefinition & { version: number }) {
    const { version, ...def } = input;
    return this.prisma.$transaction(async (tx) => {
      const rule = await this.lockRule(tx, id);
      this.checkVersion(rule, version);
      if (rule.enabled) await this.access.assertPermission(tx, caller.auth, P.enable);
      await this.validate(tx, caller, def, rule.enabled);
      const after = await tx.automationRule.update({
        where: { id },
        data: {
          name: def.name, triggerType: def.triggerType, eventType: def.eventType ?? null, schedule: (def.schedule ?? null) as Prisma.InputJsonValue,
          conditions: def.conditions as Prisma.InputJsonValue, actions: def.actions as Prisma.InputJsonValue, ownerUserId: caller.actor.id, version: { increment: 1 },
        },
      });
      await this.audit.record(tx, { actor: caller.actor, action: 'automations.rule.updated', entityType: 'AutomationRule', entityId: id, model: 'AutomationRule', before: audited(rule), after: audited(after) });
      return this.view(after);
    });
  }

  /** Switches a rule on (or changes its test mode while on). The caller becomes its owner. */
  async enable(caller: Caller, id: string, input: { version: number; testMode: boolean }, now: Date = new Date()) {
    return this.prisma.$transaction(async (tx) => {
      // Serialises switching rules on, so two requests cannot both pass the count.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('automation_rules:enable'))`;
      const rule = await this.lockRule(tx, id);
      this.checkVersion(rule, input.version);
      const def = automationRuleDefinitionSchema.safeParse(definitionOf(rule));
      if (!def.success) throw unprocessable('rule_invalid', 'This automation uses something that is no longer available. Edit it first.');
      await this.validate(tx, caller, def.data, true);
      if (!rule.enabled && (await tx.automationRule.count({ where: { enabled: true } })) >= MAX_ENABLED_RULES) {
        throw unprocessable('too_many_enabled_rules', `At most ${MAX_ENABLED_RULES} automations can be on at once`);
      }
      const after = await tx.automationRule.update({
        where: { id },
        data: { enabled: true, testMode: input.testMode, enabledAt: rule.enabled ? rule.enabledAt : now, ownerUserId: caller.actor.id, version: { increment: 1 } },
      });
      await this.audit.record(tx, { actor: caller.actor, action: 'automations.rule.enabled', entityType: 'AutomationRule', entityId: id, model: 'AutomationRule', before: audited(rule), after: audited(after) });
      return this.view(after);
    });
  }

  async disable(caller: Caller, id: string, input: { version: number }) {
    return this.prisma.$transaction(async (tx) => {
      const rule = await this.lockRule(tx, id);
      this.checkVersion(rule, input.version);
      if (!rule.enabled) throw conflict('automation_already_off', 'This automation is already off');
      const after = await tx.automationRule.update({ where: { id }, data: { enabled: false, version: { increment: 1 } } });
      await this.audit.record(tx, { actor: caller.actor, action: 'automations.rule.disabled', entityType: 'AutomationRule', entityId: id, model: 'AutomationRule', before: audited(rule), after: audited(after) });
      return this.view(after);
    });
  }

  async remove(caller: Caller, id: string, version: number, now: Date = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rule = await this.lockRule(tx, id);
      this.checkVersion(rule, version);
      if (rule.enabled) throw conflict('automation_is_on', 'Switch this automation off before deleting it');
      const after = await tx.automationRule.update({ where: { id }, data: { deletedAt: now, deletedById: caller.actor.id, version: { increment: 1 } } });
      await this.audit.record(tx, { actor: caller.actor, action: 'automations.rule.deleted', entityType: 'AutomationRule', entityId: id, model: 'AutomationRule', before: audited(rule), after: audited(after) });
    });
  }

  async list() {
    const rules = await this.prisma.automationRule.findMany({ where: { deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const last = rules.length
      ? await this.prisma.$queryRaw<Array<{ ruleId: string; status: string; startedAt: Date; testMode: boolean }>>`
          SELECT DISTINCT ON ("ruleId") "ruleId"::text AS "ruleId", status::text AS status, "startedAt", "testMode"
          FROM automation_runs WHERE "ruleId" = ANY(${rules.map((r) => r.id)}::uuid[]) ORDER BY "ruleId", "startedAt" DESC`
      : [];
    const byRule = new Map(last.map((l) => [l.ruleId, l]));
    return { items: rules.map((r) => ({ ...this.view(r), lastRun: byRule.get(r.id) ?? null })) };
  }

  async get(id: string) {
    const rule = await this.prisma.automationRule.findUnique({ where: { id } });
    if (!rule || rule.deletedAt) throw notFound('automation_not_found', 'Automation not found');
    return this.view(rule);
  }

  async runs(id: string, q: { limit: number; before?: string }) {
    await this.get(id);
    const items = await this.prisma.automationRun.findMany({
      where: { ruleId: id, ...(q.before ? { startedAt: { lt: new Date(q.before) } } : {}) },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: q.limit,
      select: {
        id: true, ruleVersion: true, source: true, triggerEventType: true, scheduledFor: true, entityType: true, entityId: true, testMode: true, status: true,
        reasonCode: true, steps: true, attempts: true, startedAt: true, finishedAt: true,
      },
    });
    return { items };
  }

  view(r: RuleRow) {
    return {
      id: r.id, ...definitionOf(r), enabled: r.enabled, testMode: r.testMode, enabledAt: r.enabledAt, ownerUserId: r.ownerUserId, version: r.version,
      createdAt: r.createdAt, updatedAt: r.updatedAt, permissions: (() => {
        const d = automationRuleDefinitionSchema.safeParse(definitionOf(r));
        try {
          return d.success ? this.permissionsFor(d.data) : [];
        } catch {
          return [];
        }
      })(),
    };
  }
}
