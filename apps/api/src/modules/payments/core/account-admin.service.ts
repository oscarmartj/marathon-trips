import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import type { AppConfig } from '../../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { SettingsService } from '../../../platform/flags/flags.service';
import { conflict, notFound } from '../../../platform/http/api-error';
import { MANUAL_KEY } from '../adapters/manual/manual';
import { PLANNED_ADAPTERS } from '../adapters/planned';
import { ACCOUNT_VIEW_SELECT } from './accounts.service';
import type { AccountStatus, ArchiveFacts } from './account-rules';
import { allowedTransitions, archiveBlockers, bootPauseReason, connectionTestCurrent, creationBlockReason, transitionAllowed } from './account-rules';
import { CollectionCoverageGuard } from './coverage-guard';
import { ProviderGateway, callBlockReason } from './gateway';
import type { ConnectionTestCode } from './gateway';
import { ManualMethodsService } from './manual-methods.service';
import { PAYMENT_SETTINGS } from './settings';
import { WEBHOOK_PATH_PREFIX, webhookPathTokenHash } from './webhooks.service';

type Tx = Prisma.TransactionClient;
type AccountRow = Prisma.ProviderAccountGetPayload<{ select: typeof ACCOUNT_VIEW_SELECT }>;

/** Webhook rejections that count for the "check the webhook secret" warning. */
const WEBHOOK_WARNING_DAYS = 7;

export type AccountWarning =
  | { code: 'no_method_for_country'; country: string }
  | { code: 'active_without_current_test'; accountId: string }
  | { code: 'paused_by_system'; accountId: string; reason: string }
  | { code: 'webhook_rejected_since_change'; accountId: string }
  | { code: 'webhook_secret_missing'; accountId: string }
  | { code: 'adapter_missing'; accountId: string }
  | { code: 'adapter_planned_with_account'; accountId: string };

/** More archive checks, added by later tasks (4.5: open disputes; 4.6: unsettled clearing balance). Codes only. */
export type ArchiveCheck = (tx: Tx, accountId: string) => Promise<string[]>;

/**
 * The panel's side of gateway accounts (task 4.1, plan docs/plans/4.1-provider-accounts-panel.md): the adapter catalogue,
 * the accounts with their warnings, renaming, status changes, the connection test and a new webhook URL. Secrets are
 * changed by ProviderAccountsService and decrypted only by ProviderGateway; nothing here selects a secret column.
 */
@Injectable()
export class ProviderAccountsAdminService {
  private readonly archiveChecks = new Map<string, ArchiveCheck>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CollectionCoverageGuard) private readonly coverage: CollectionCoverageGuard,
    @Inject(ManualMethodsService) private readonly manualMethods: ManualMethodsService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  registerArchiveCheck(name: string, check: ArchiveCheck): void {
    this.archiveChecks.set(name, check);
  }

  /** Every adapter in the code, with what an account of it needs and whether one can be created here (test mode). */
  adapters() {
    return this.gateway.registry.all().map(({ manifest: m }) => {
      const blocked = creationBlockReason(m, 'test', this.config.APP_ENV);
      return {
        key: m.key, displayName: m.displayName, status: m.status, testOnly: m.testOnly, methods: [...m.methods], currencies: [...m.currencies],
        countries: m.countries === 'any' ? 'any' : [...m.countries], refunds: m.capabilities.refunds,
        credentialFields: m.account.fields.map((f) => ({ key: f.key, label: f.label })),
        webhookSecret: m.account.webhookSecret.source === 'entered' ? { source: 'entered' as const, label: m.account.webhookSecret.label } : { source: 'generated' as const },
        creatable: blocked === null, creatableReason: blocked, mode: 'test' as const,
      };
    }).concat(PLANNED_ADAPTERS.filter((p) => !this.gateway.registry.get(p.key)).map((p) => ({
      // Catalogue entries only (task 4.2, plan section 7): nothing can be created or routed to them.
      key: p.key, displayName: p.displayName, status: 'planned' as const, testOnly: false, methods: [...p.methods], currencies: [...p.currencies],
      countries: p.countries === 'any' ? 'any' : [...p.countries], refunds: 'none' as const, credentialFields: [], webhookSecret: { source: 'generated' as const },
      creatable: false, creatableReason: 'adapter_unavailable', mode: 'test' as const,
    })));
  }

  async accounts() {
    const rows = await this.prisma.providerAccount.findMany({ select: ACCOUNT_VIEW_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const ids = rows.map((r) => r.id);
    const [events, rejections, payments] = await Promise.all([
      this.prisma.webhookEvent.groupBy({ by: ['providerAccountId'], where: { providerAccountId: { in: ids } }, _max: { receivedAt: true } }),
      this.prisma.webhookRejection.findMany({ where: { providerAccountId: { in: ids } }, orderBy: { receivedAt: 'desc' }, distinct: ['providerAccountId'], select: { providerAccountId: true, receivedAt: true, reason: true } }),
      this.prisma.payment.groupBy({ by: ['providerAccountId'], where: { providerAccountId: { in: ids } }, _count: { _all: true } }),
    ]);
    return rows.map((r) => {
      const m = this.gateway.registry.get(r.adapterKey)?.manifest;
      const rejected = rejections.find((x) => x.providerAccountId === r.id);
      const { webhookKeyVersion, ...rest } = r;
      return {
        ...rest,
        adapterStatus: m?.status ?? 'unknown', adapterTestOnly: m?.testOnly ?? true,
        webhookSecretSet: webhookKeyVersion !== null,
        connectionTestCurrent: connectionTestCurrent(r),
        lastWebhookReceivedAt: events.find((e) => e.providerAccountId === r.id)?._max.receivedAt ?? null,
        lastWebhookRejection: rejected ? { at: rejected.receivedAt, reason: rejected.reason } : null,
        hasHistory: (payments.find((p) => p.providerAccountId === r.id)?._count._all ?? 0) > 0 || events.some((e) => e.providerAccountId === r.id),
        allowedTransitions: allowedTransitions(r.status),
      };
    });
  }

  /** The panel's warnings (plan 4.1, section 6): codes and ids only. */
  async warnings(): Promise<AccountWarning[]> {
    const out: AccountWarning[] = [];
    for (const country of await this.prisma.$transaction((tx) => this.coverage.countriesWithoutMethod(tx))) out.push({ code: 'no_method_for_country', country });
    const rows = await this.prisma.providerAccount.findMany({ where: { status: { not: 'archived' } }, select: ACCOUNT_VIEW_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const since = new Date(Date.now() - WEBHOOK_WARNING_DAYS * 86_400_000);
    for (const r of rows) {
      const m = this.gateway.registry.get(r.adapterKey)?.manifest;
      if (!m) out.push({ code: 'adapter_missing', accountId: r.id });
      else if (m.status === 'planned') out.push({ code: 'adapter_planned_with_account', accountId: r.id });
      if (r.status === 'active' && !connectionTestCurrent(r)) out.push({ code: 'active_without_current_test', accountId: r.id });
      if (r.status === 'paused' && r.pauseReasonCode && r.pauseReasonCode !== 'staff') out.push({ code: 'paused_by_system', accountId: r.id, reason: r.pauseReasonCode });
      if (m?.account.webhookSecret.source === 'entered' && r.webhookKeyVersion === null) out.push({ code: 'webhook_secret_missing', accountId: r.id });
      const after = r.credentialsChangedAt > since ? r.credentialsChangedAt : since;
      const bad = await this.prisma.webhookRejection.count({ where: { providerAccountId: r.id, reason: 'bad_signature', receivedAt: { gte: after } } });
      if (bad > 0) out.push({ code: 'webhook_rejected_since_change', accountId: r.id });
    }
    return out;
  }

  async rename(id: string, input: { version: number; displayName: string }, actor: AuditActor) {
    return runTransaction(this.prisma, async (tx) => {
      const row = await this.lockAccount(tx, id, input.version);
      if (row.displayName === input.displayName) return { version: row.version };
      await tx.providerAccount.update({ where: { id }, data: { displayName: input.displayName, version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'payments.providerAccount.renamed', entityType: 'ProviderAccount', entityId: id, model: 'ProviderAccount', before: { displayName: row.displayName }, after: { displayName: input.displayName } });
      return { version: row.version + 1 };
    });
  }

  /** Status changes (plan 4.1, 4.3): one advisory lock for every change that can stop a way to pay, then the row. */
  async setStatus(id: string, input: { version: number; status: AccountStatus; confirmCoverageLoss?: boolean; reason?: string }, actor: AuditActor) {
    return runTransaction(this.prisma, async (tx) => {
      await this.coverage.lock(tx);
      const row = await this.lockAccount(tx, id, input.version);
      const to = input.status;
      if (!transitionAllowed(row.status, to)) throw conflict('status_transition_not_allowed', 'An account cannot move to that status from its current one');
      const manifest = this.gateway.registry.get(row.adapterKey)?.manifest;
      if (to === 'active') {
        if (!connectionTestCurrent(row)) throw conflict('connection_test_required', 'Run a connection test that passes with the current details before activating the account');
        const reason = callBlockReason({ ...row, status: 'active' }, manifest, 'create', this.gateway.env);
        if (reason) throw conflict(reason, 'This payment account cannot take payments here');
      }
      if (to === 'archived') {
        const blockers = await this.archiveBlockersOf(tx, id);
        if (blockers.length > 0) throw conflict('archive_blocked', 'This account still has payments, refunds or disputes to look after', { reasons: blockers });
      }
      const apply = async () => {
        await tx.providerAccount.update({ where: { id }, data: { status: to, pauseReasonCode: to === 'paused' ? 'staff' : null, version: { increment: 1 } } });
      };
      const lost = row.status === 'active' ? await this.coverage.guard(tx, input.confirmCoverageLoss === true, apply) : (await apply(), []);
      await this.audit.record(tx, {
        actor, action: 'payments.providerAccount.statusChanged', entityType: 'ProviderAccount', entityId: id, model: 'ProviderAccount', reason: input.reason,
        before: { status: row.status }, after: { status: to }, context: { lostCount: lost.length },
      });
      return { version: row.version + 1, status: to, lost };
    });
  }

  /**
   * Runs the account's connection test (plan 4.1, 4.2 and 15.4). The result is recorded only for the credentials that
   * were tested: a rotation committed meanwhile makes the compare-and-set miss, and the result is reported, not stored.
   */
  async connectionTest(id: string, actor: AuditActor) {
    const exists = await this.prisma.providerAccount.findUnique({ where: { id }, select: { adapterKey: true } });
    if (!exists) throw notFound('provider_account_not_found', 'Payment account not found');
    const { result: gatewayResult, credentialsChangedAt } = await this.gateway.testConnection(id);
    const result: ConnectionTestCode = gatewayResult === 'ok' && exists.adapterKey === MANUAL_KEY && !(await this.manualMethods.anyReady()) ? 'manual_instructions_invalid' : gatewayResult;
    const recorded = await runTransaction(this.prisma, async (tx) => {
      const n = await tx.$executeRaw`UPDATE provider_accounts SET "lastConnectionTestAt" = now(), "lastConnectionTestResult" = ${result}, "updatedAt" = now()
        WHERE id = ${id}::uuid AND "credentialsChangedAt" = ${credentialsChangedAt}`;
      await this.audit.record(tx, { actor, action: 'payments.providerAccount.connectionTested', entityType: 'ProviderAccount', entityId: id, context: { result, recorded: n === 1 } });
      return n === 1;
    });
    const rejection = await this.prisma.webhookRejection.findFirst({ where: { providerAccountId: id, receivedAt: { gte: credentialsChangedAt } }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true, reason: true } });
    const received = await this.prisma.webhookEvent.findFirst({ where: { providerAccountId: id, receivedAt: { gte: credentialsChangedAt } }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } });
    return { result, recorded, webhook: { lastReceivedAt: received?.receivedAt ?? null, lastRejection: rejection ? { at: rejection.receivedAt, reason: rejection.reason } : null } };
  }

  /** A new webhook URL (plan 4.1, 4.4): the old one stops matching at once; the new one is returned this once. */
  async regenerateWebhookUrl(id: string, input: { version: number }, actor: AuditActor): Promise<{ version: number; webhookUrl: string }> {
    const pathToken = randomBytes(32).toString('base64url');
    return runTransaction(this.prisma, async (tx) => {
      const row = await this.lockAccount(tx, id, input.version);
      await tx.providerAccount.update({ where: { id }, data: { webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, pathToken), version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'payments.providerAccount.webhookUrlRegenerated', entityType: 'ProviderAccount', entityId: id, model: 'ProviderAccount', before: { webhookPathTokenHash: 'a' }, after: { webhookPathTokenHash: 'b' } });
      return { version: row.version + 1, webhookUrl: `${this.config.API_BASE_URL}${WEBHOOK_PATH_PREFIX}/${pathToken}` };
    });
  }

  private async archiveBlockersOf(tx: Tx, id: string): Promise<string[]> {
    const [liveAttempts, openRefunds, lastPayment, lastRefund] = await Promise.all([
      tx.payment.count({ where: { providerAccountId: id, status: { in: ['created', 'requires_action', 'pending'] } } }),
      tx.refund.count({ where: { providerAccountId: id, status: { in: ['requested', 'pending'] } } }),
      tx.payment.aggregate({ where: { providerAccountId: id, status: 'succeeded' }, _max: { succeededAt: true } }),
      tx.refund.aggregate({ where: { providerAccountId: id, status: { in: ['succeeded', 'reversed'] } }, _max: { succeededAt: true } }),
    ]);
    const dates = [lastPayment._max.succeededAt, lastRefund._max.succeededAt].filter((d): d is Date => !!d);
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now` as [{ now: Date }];
    const facts: ArchiveFacts = {
      liveAttempts, openRefunds, lastMoneyAt: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null, now,
      disputeWindowDays: await this.settings.get<number>(PAYMENT_SETTINGS.disputeWindowDays.key, PAYMENT_SETTINGS.disputeWindowDays.fallback),
    };
    const out = archiveBlockers(facts);
    for (const check of this.archiveChecks.values()) out.push(...(await check(tx, id)));
    return out;
  }

  private async lockAccount(tx: Tx, id: string, version: number): Promise<AccountRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM provider_accounts WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound('provider_account_not_found', 'Payment account not found');
    const row = await tx.providerAccount.findUniqueOrThrow({ where: { id }, select: ACCOUNT_VIEW_SELECT });
    if (row.version !== version) throw conflict('version_conflict', 'Someone else changed this account. Reload and try again.');
    return row;
  }
}

/**
 * At start-up (plan 4.1, 4.5): an active account whose adapter is no longer in the code, or is only `planned`, is paused
 * once (compare-and-set), audited and given a task. It never activates anything and never decrypts. The live branches
 * belong to the task that lifts `CHECK (mode = 'test')` (plan 4.1, section 14).
 */
@Injectable()
export class ProviderAccountsBootCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('PaymentAccounts');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  async run(): Promise<string[]> {
    const rows = await this.prisma.providerAccount.findMany({ where: { status: 'active' }, select: { id: true, adapterKey: true } });
    const paused: string[] = [];
    for (const r of rows) {
      const reason = bootPauseReason(this.gateway.registry.get(r.adapterKey)?.manifest);
      if (!reason) continue;
      const done = await runTransaction(this.prisma, async (tx) => {
        const n = await tx.providerAccount.updateMany({ where: { id: r.id, status: 'active' }, data: { status: 'paused', pauseReasonCode: reason, version: { increment: 1 } } });
        if (n.count !== 1) return false;
        await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'payments.providerAccount.pausedAtBoot', entityType: 'ProviderAccount', entityId: r.id, model: 'ProviderAccount', before: { status: 'active' }, after: { status: 'paused', pauseReasonCode: reason } });
        await this.tasks.createSystemIn(tx, {
          title: 'Payment account paused at start-up',
          description: `The payment account ${r.id} was paused when the API started (${reason}): its adapter is not available in this version. Nothing else was changed.`,
          entityType: 'ProviderAccount', entityId: r.id, sourceRef: `payments:account_paused_at_boot:${r.id}`,
        });
        return true;
      });
      if (done) paused.push(r.id);
    }
    if (paused.length > 0) this.logger.warn(`paused ${paused.length} payment account(s) at start-up`);
    return paused;
  }
}
