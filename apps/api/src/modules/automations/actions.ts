import { Inject, Injectable } from '@nestjs/common';
import { automationTemplateKey, isCustomerTemplate } from '@mt/shared';
import type { AutomationAction, AutomationActionType, AutomationEntityType, AutomationStep } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../../platform/access/access.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { TagsService } from '../../platform/common/tags.service';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { COMMON_PERMISSIONS_KEYS } from '../../platform/common/permissions';
import type { AppConfig } from '../../platform/config/config';
import { emailHash } from '../../platform/crypto/hmac';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { AppError } from '../../platform/errors/safe-error';
import { assertIdentifiersOnly } from '../../platform/guards/no-personal-data';
import { unprocessable } from '../../platform/http/api-error';
import { AUTOMATION_RULE_FIRED, buildOutboundBody } from '../../platform/integrations/webhook-catalogue';
import { WebhookDeliveryService } from '../../platform/integrations/webhook-delivery.service';
import { MailService } from '../../platform/mail/mail.service';
import { TemplatesService } from '../templates';
import type { LoadedEntity } from './facts';
import { AUTOMATIONS_PERMISSIONS, ENTITY_READ_PERMISSION } from './manifest';

type Tx = Prisma.TransactionClient;
type Scope = AutomationEntityType | 'schedule';
export type StepResult = Pick<AutomationStep, 'status' | 'code' | 'entityType' | 'entityId'>;

/** What an action knows while it runs: the rule, the run, the record (if any) and whether this is only a test. */
export interface ActionRunContext {
  tx: Tx;
  testMode: boolean;
  rule: { id: string; name: string; ownerUserId: string };
  run: { id: string; triggerEventType: string | null; scheduledFor: Date | null };
  index: number;
  entity: LoadedEntity | null;
  actor: AuditActor & { id: string };
  now: Date;
}

/** What an action knows when a rule is saved or switched on. */
export interface ActionSaveContext {
  tx: Tx;
  scope: Scope;
  /** True when the rule is being switched on (or changed while on): everything it needs must be in place. */
  enabling: boolean;
}

export interface ActionDef<T extends AutomationAction = AutomationAction> {
  type: T['type'];
  /** Declared for the registry's check; always false for a registered action. */
  movesMoney: boolean;
  changesPermissions: boolean;
  /** Every permission this action can ever ask of the rule's owner. */
  declaredPermissions: readonly string[];
  allowedOn: readonly Scope[];
  permissions(action: T, scope: Scope): string[];
  validate(action: T, ctx: ActionSaveContext): Promise<void>;
  run(action: T, ctx: ActionRunContext): Promise<StepResult>;
}

/**
 * Permissions no automation action may ever use: money (payments, finance, prices, booking changes), access, audit,
 * platform settings and flags, API keys, booking transitions (decision of 2026-11-12) and the rules themselves.
 */
export const FORBIDDEN_ACTION_PERMISSIONS: readonly RegExp[] = [
  /^(payments|finance|pricing|changes|access|audit|platform)\./,
  /^integrations\.apiKey\./,
  /^automations\./,
  /^bookings\.booking\.(approve|decline|cancel)$/,
];

export const isForbiddenActionPermission = (key: string): boolean => FORBIDDEN_ACTION_PERMISSIONS.some((r) => r.test(key));

/** The closed list of actions. Registering one that could move money or change permissions fails at start-up. */
export class ActionRegistry {
  private readonly defs = new Map<string, ActionDef>();

  register(def: ActionDef): void {
    if (def.movesMoney || def.changesPermissions) throw new AppError('automation_action_forbidden', `Action ${def.type} would move money or change permissions`);
    const bad = def.declaredPermissions.filter(isForbiddenActionPermission);
    if (bad.length > 0) throw new AppError('automation_action_forbidden', `Action ${def.type} declares a permission no automation may use`);
    if (this.defs.has(def.type)) throw new AppError('automation_action_duplicate', `Action ${def.type} is registered twice`);
    this.defs.set(def.type, def);
  }

  get(type: AutomationActionType): ActionDef {
    const def = this.defs.get(type);
    if (!def) throw new AppError('automation_action_unknown', 'This action is not available');
    return def;
  }

  all(): ActionDef[] {
    return [...this.defs.values()];
  }

  /** The permissions an action asks for here, checked against what it declared. */
  permissionsOf(action: AutomationAction, scope: Scope): string[] {
    const def = this.get(action.type);
    const keys = def.permissions(action as never, scope);
    if (keys.some((k) => !def.declaredPermissions.includes(k) || isForbiddenActionPermission(k))) {
      throw new AppError('automation_action_forbidden', `Action ${def.type} asked for a permission it did not declare`);
    }
    return keys;
  }
}

const done = (entityType?: string, entityId?: string): StepResult => ({ status: 'done', ...(entityType && entityId ? { entityType, entityId } : {}) });
const simulated = (): StepResult => ({ status: 'simulated' });
const skipped = (code: NonNullable<StepResult['code']>): StepResult => ({ status: 'skipped', code });

/** The record's reference and its customer, for the records that have one (bookings and quotes). */
function customerOf(entity: LoadedEntity | null) {
  if (entity?.entityType === 'Booking') return entity.booking.customer;
  if (entity?.entityType === 'Quote') return entity.quote.customer;
  return null;
}

/** Builds the action definitions with the services they need. */
@Injectable()
export class AutomationActions {
  readonly registry = new ActionRegistry();

  constructor(
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(TagsService) private readonly tags: TagsService,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(WebhookDeliveryService) private readonly webhooks: WebhookDeliveryService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    for (const d of this.definitions()) this.registry.register(d as ActionDef);
  }

  /** Whether the webhook subscription can receive this rule's notice now (see plan section 5, point 2). */
  async webhookUsable(tx: Tx, subscriptionId: string, scope: Scope): Promise<boolean> {
    const sub = await tx.webhookSubscription.findUnique({ where: { id: subscriptionId }, select: { enabled: true, deletedAt: true, eventTypes: true, createdById: true } });
    if (!sub || !sub.enabled || sub.deletedAt || !sub.eventTypes.includes(AUTOMATION_RULE_FIRED)) return false;
    const eff = await this.access.effective(tx, sub.createdById);
    const needed = [AUTOMATIONS_PERMISSIONS.read, ...(scope === 'schedule' ? [] : [ENTITY_READ_PERMISSION[scope]])];
    return needed.every((k) => eff.keys.has(k));
  }

  private definitions(): Array<ActionDef<never>> {
    const all: readonly Scope[] = ['Booking', 'Quote', 'Package', 'schedule'];
    const records: readonly Scope[] = ['Booking', 'Quote', 'Package'];
    type A<K extends AutomationActionType> = Extract<AutomationAction, { type: K }>;

    const createTask: ActionDef<A<'create_task'>> = {
      type: 'create_task', movesMoney: false, changesPermissions: false, allowedOn: all,
      declaredPermissions: [COMMON_PERMISSIONS_KEYS.taskWrite],
      permissions: () => [COMMON_PERMISSIONS_KEYS.taskWrite],
      validate: async (a, { tx }) => {
        if (a.assigneeId && !(await tx.user.findFirst({ where: { id: a.assigneeId, kind: 'staff', status: 'active' }, select: { id: true } }))) {
          throw unprocessable('automation_assignee_unknown', 'That person cannot be assigned');
        }
      },
      run: async (a, ctx) => {
        if (ctx.testMode) return simulated();
        const { id, assigneeDropped } = await this.tasks.createAutomatedIn(ctx.tx, ctx.actor, {
          title: a.title, description: a.description ?? null, assigneeId: a.assigneeId ?? null,
          dueAt: a.dueInHours === undefined ? null : new Date(ctx.now.getTime() + a.dueInHours * 3_600_000),
          entityType: ctx.entity?.entityType ?? null, entityId: ctx.entity?.id ?? null, sourceRef: `automation:${ctx.rule.id}:${ctx.run.id}:${ctx.index}`,
        }, { runId: ctx.run.id });
        return { ...done('Task', id), ...(assigneeDropped ? { code: 'assignee_unavailable' as const } : {}) };
      },
    };

    const tagAction = (op: 'add' | 'remove'): ActionDef<A<'add_tag'> | A<'remove_tag'>> => ({
      type: op === 'add' ? 'add_tag' : 'remove_tag', movesMoney: false, changesPermissions: false, allowedOn: ['Booking'],
      declaredPermissions: ['bookings.booking.annotate'],
      permissions: () => [this.bookingTable().permissions.annotate ?? 'bookings.booking.annotate'],
      validate: async (a, { tx }) => {
        const tag = await tx.tag.findUnique({ where: { id: a.tagId }, select: { entityTypes: true } });
        if (!tag || (tag.entityTypes.length > 0 && !tag.entityTypes.includes('Booking'))) throw unprocessable('automation_tag_invalid', 'That tag does not exist or cannot be used on bookings');
      },
      run: async (a, ctx) => {
        if (!ctx.entity) return skipped('entity_gone');
        if (ctx.testMode) {
          const tag = await ctx.tx.tag.findUnique({ where: { id: a.tagId }, select: { entityTypes: true } });
          return !tag || (tag.entityTypes.length > 0 && !tag.entityTypes.includes('Booking')) ? skipped('tag_unavailable') : simulated();
        }
        const r = await this.tags.changeOneIn(ctx.tx, ctx.actor, this.bookingTable(), ctx.entity.id, a.tagId, op, { runId: ctx.run.id });
        return r === 'done' ? done() : skipped(r);
      },
    });

    const closeTasks: ActionDef<A<'close_tasks'>> = {
      type: 'close_tasks', movesMoney: false, changesPermissions: false, allowedOn: records,
      declaredPermissions: [COMMON_PERMISSIONS_KEYS.taskManageAutomated],
      permissions: () => [COMMON_PERMISSIONS_KEYS.taskManageAutomated],
      validate: async () => undefined,
      run: async (a, ctx) => {
        if (!ctx.entity) return skipped('entity_gone');
        const ids = await this.tasks.openAutomatedOn(ctx.tx, ctx.entity.entityType, ctx.entity.id, a.onlyThisRule ? `automation:${ctx.rule.id}:` : undefined);
        if (ids.length === 0) return skipped('nothing_to_close');
        if (ctx.testMode) return simulated();
        await this.tasks.closeAutomatedIn(ctx.tx, ctx.actor, ids, { runId: ctx.run.id });
        return done();
      },
    };

    const sendEmail: ActionDef<A<'send_email'>> = {
      type: 'send_email', movesMoney: false, changesPermissions: false, allowedOn: all,
      declaredPermissions: ['bookings.customer.read', ...Object.values(ENTITY_READ_PERMISSION)],
      permissions: (a, scope) => (isCustomerTemplate(a.template) ? ['bookings.customer.read'] : scope === 'schedule' ? [] : [ENTITY_READ_PERMISSION[scope]]),
      validate: async (a, { tx, scope, enabling }) => {
        if (isCustomerTemplate(a.template) && scope !== 'Booking' && scope !== 'Quote') throw unprocessable('automation_action_not_allowed', 'Customer emails need a booking or quote trigger');
        if (enabling && !(await this.templates.activeWording(tx, 'email', automationTemplateKey(a.template), 'en-AU'))) {
          throw unprocessable('automation_template_not_in_use', 'Put the email template into use before switching this automation on');
        }
      },
      run: async (a, ctx) => {
        const key = automationTemplateKey(a.template);
        const dedupeKey = `automation:${ctx.run.id}:${ctx.index}`;
        if (isCustomerTemplate(a.template)) {
          const customer = customerOf(ctx.entity);
          if (!customer || customer.unavailable) return skipped('recipient_unavailable');
          // Service notices still respect the suppression list (bounces, complaints, unsubscribes), whatever its scope.
          if (await ctx.tx.emailSuppression.findUnique({ where: { emailHash: emailHash(this.config.EMAIL_HASH_KEY, customer.email) }, select: { id: true } })) return skipped('recipient_suppressed');
          if (ctx.testMode) return simulated();
          const r = await this.mail.enqueue({
            to: customer.email, templateKey: key, templateVersion: 1, locale: customer.preferredLocale, dedupeKey, category: 'transactional',
            customerId: customer.id, relatedEntityType: ctx.entity!.entityType, relatedEntityId: ctx.entity!.id,
          }, ctx.tx);
          return done('OutboundEmail', r.id);
        }
        const owner = await ctx.tx.user.findUnique({ where: { id: ctx.rule.ownerUserId }, select: { email: true, status: true } });
        if (!owner || owner.status !== 'active') return skipped('recipient_unavailable');
        if (ctx.testMode) return simulated();
        const r = await this.mail.enqueue({ to: owner.email, templateKey: key, templateVersion: 1, locale: 'en-AU', dedupeKey, relatedEntityType: 'AutomationRun', relatedEntityId: ctx.run.id }, ctx.tx);
        return done('OutboundEmail', r.id);
      },
    };

    const callWebhook: ActionDef<A<'call_webhook'>> = {
      type: 'call_webhook', movesMoney: false, changesPermissions: false, allowedOn: all,
      declaredPermissions: ['integrations.webhook.manage'],
      permissions: () => ['integrations.webhook.manage'],
      validate: async (a, { tx, scope }) => {
        const sub = await tx.webhookSubscription.findUnique({ where: { id: a.subscriptionId }, select: { deletedAt: true, eventTypes: true } });
        if (!sub || sub.deletedAt || !sub.eventTypes.includes(AUTOMATION_RULE_FIRED)) throw unprocessable('webhook_not_subscribed', `Choose a webhook that subscribes to ${AUTOMATION_RULE_FIRED}`);
        if (!(await this.webhookUsable(tx, a.subscriptionId, scope))) throw unprocessable('automation_webhook_not_allowed', 'That webhook is off, or whoever created it cannot see these records');
      },
      run: async (a, ctx) => {
        const scope: Scope = ctx.entity?.entityType ?? 'schedule';
        if (!(await this.webhookUsable(ctx.tx, a.subscriptionId, scope))) return skipped('webhook_unavailable');
        if (ctx.testMode) return simulated();
        const body = buildOutboundBody({
          id: ctx.run.id, type: AUTOMATION_RULE_FIRED, schemaVersion: 1, aggregateType: 'AutomationRun', aggregateId: ctx.run.id, aggregateVersion: null, occurredAt: ctx.now,
          payload: {
            ruleId: ctx.rule.id, runId: ctx.run.id, triggerEventType: ctx.run.triggerEventType, entityType: ctx.entity?.entityType ?? null, entityId: ctx.entity?.id ?? null,
            scheduledFor: ctx.run.scheduledFor ? ctx.run.scheduledFor.toISOString() : null,
          },
        });
        assertIdentifiersOnly('event payload', body.data);
        await this.webhooks.insertDelivery(ctx.tx, a.subscriptionId, ctx.run.id, AUTOMATION_RULE_FIRED, body);
        return done();
      },
    };

    return [createTask, tagAction('add'), tagAction('remove'), closeTasks, sendEmail, callWebhook] as unknown as Array<ActionDef<never>>;
  }

  private bookingTable() {
    const table = this.entities.get('Booking')?.table;
    if (!table) throw new AppError('automation_entity_table_missing', 'Bookings have no table registered');
    return table;
  }
}
