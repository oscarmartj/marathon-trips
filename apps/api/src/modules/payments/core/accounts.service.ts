import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import type { AppConfig } from '../../../platform/config/config';
import type { SecretBox } from '../../../platform/crypto/secret-box';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { SECRET_BOX } from '../../../platform/auth/staff-auth.service';
import { AppError } from '../../../platform/errors/safe-error';
import { MANUAL_KEY } from '../adapters/manual/manual';
import { SIMULATOR_KEY } from '../adapters/simulator/simulator';
import { STRIPE_KEY } from '../adapters/stripe/stripe';
import { conflict, notFound, unprocessable } from '../../../platform/http/api-error';
import { runTransaction } from '../../../platform/database/transaction';
import { checkCredentials, creationBlockReason, secretsChangeAcceptable, webhookSecretValid } from './account-rules';
import { ProviderGateway, TEST_ADAPTER_ENVS, credentialsAad, webhookSecretAad } from './gateway';
import type { ConnectionTestCode } from './gateway';
import { ManualMethodsService } from './manual-methods.service';
import { ProviderHealthService } from './provider-health.service';
import { insertDefaultRules } from './routing-admin.service';
import { WEBHOOK_PATH_PREFIX, webhookPathTokenHash } from './webhooks.service';

/** What the panel and the console may see of an account: never a secret column. */
export const ACCOUNT_VIEW_SELECT = {
  id: true, adapterKey: true, displayName: true, mode: true, status: true, lastConnectionTestAt: true, lastConnectionTestResult: true, createdAt: true,
  version: true, pauseReasonCode: true, credentialsChangedAt: true, webhookKeyVersion: true,
} as const;

/**
 * Provider accounts (plan 3.1, section 7). In 3.1 only simulator accounts in test mode, created from the console or
 * the demo seed; the panel and live accounts arrive with 4.1. Credentials and the webhook secret are generated here,
 * encrypted with AAD bound to the account, and never shown; the webhook URL is printed once.
 */
@Injectable()
export class ProviderAccountsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(ManualMethodsService) private readonly manualMethods: ManualMethodsService,
    @Inject(ProviderHealthService) private readonly health: ProviderHealthService,
  ) {}

  // ---- The panel (task 4.1, plan docs/plans/4.1-provider-accounts-panel.md, sections 4.1 and 4.4) ----

  /**
   * Creates an account from the panel: test mode only, born paused, its credentials tested as a candidate first and
   * stored encrypted with the result, test time = change time (plan 4.1, 15.1). The webhook URL is returned once.
   */
  async createFromPanel(input: { adapterKey: string; displayName: string; mode: string; credentials: unknown }, actor: AuditActor): Promise<{ id: string; webhookUrl: string; connectionTest: ConnectionTestCode }> {
    const manifest = this.gateway.registry.get(input.adapterKey)?.manifest;
    const refuse = async (code: string, status: 409 | 422, details: Record<string, unknown> = {}): Promise<never> => {
      await this.prisma.$transaction((tx) => this.audit.record(tx, {
        actor, action: 'payments.providerAccount.creationRefused', entityType: 'ProviderAccount', entityId: randomUUID(),
        context: { code, adapterKey: manifest ? manifest.key : 'unknown', mode: input.mode === 'test' || input.mode === 'live' ? input.mode : 'other' },
      }));
      throw status === 409 ? conflict(code, 'This payment account cannot be created here', details) : unprocessable(code, 'The account details are not valid', details);
    };
    const blocked = creationBlockReason(manifest, input.mode, this.config.APP_ENV);
    if (blocked) return refuse(blocked, blocked === 'adapter_unknown' ? 422 : 409);
    const setup = manifest!.account;
    const checked = checkCredentials(setup, input.credentials, { partial: false });
    if (!checked.ok) return refuse('credentials_invalid', 422, { fields: checked.fields });
    const credentials: Record<string, string> = { ...checked.values };
    for (const g of setup.generated ?? []) credentials[g.key] = `${g.prefix}${randomBytes(18).toString('hex')}`;
    const webhookSecret = setup.webhookSecret.source === 'generated' ? randomBytes(32).toString('hex') : null;
    const tested = await this.gateway.testCandidate(manifest!.key, 'test', { credentials, webhookSecret });
    const result = tested === 'ok' && manifest!.key === MANUAL_KEY && !(await this.manualMethods.anyReady()) ? 'manual_instructions_invalid' : tested;

    const id = randomUUID();
    const pathToken = randomBytes(32).toString('base64url');
    const creds = this.box.encrypt(JSON.stringify(credentials), credentialsAad(id));
    const secret = webhookSecret === null ? null : this.box.encrypt(webhookSecret, webhookSecretAad(id));
    await runTransaction(this.prisma, async (tx) => {
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now` as [{ now: Date }];
      const created = await tx.providerAccount.create({
        data: {
          id, adapterKey: manifest!.key, displayName: input.displayName, mode: 'test', status: 'paused', pauseReasonCode: 'staff',
          credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
          webhookSecretCiphertext: secret?.ciphertext ?? null, webhookKeyVersion: secret?.keyVersion ?? null,
          webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, pathToken), createdById: actor.id ?? null,
          credentialsChangedAt: now, lastConnectionTestAt: now, lastConnectionTestResult: result,
        },
        select: { adapterKey: true, createdAt: true },
      });
      // Its default routing rules, with its createdAt so the order of task 3.1 holds (plan 4.2, sections 6 and 15.7).
      await insertDefaultRules(tx, id, this.gateway.registry.get(created.adapterKey)!.manifest, created.createdAt);
      await this.audit.record(tx, {
        actor, action: 'payments.providerAccount.created', entityType: 'ProviderAccount', entityId: id, model: 'ProviderAccount',
        after: {
          adapterKey: manifest!.key, displayName: input.displayName, mode: 'test', status: 'paused', pauseReasonCode: 'staff', lastConnectionTestResult: result,
          credentialsCiphertext: creds.ciphertext, ...(secret ? { webhookSecretCiphertext: secret.ciphertext } : {}), webhookPathTokenHash: 'x',
        },
      });
    });
    return { id, webhookUrl: `${this.config.API_BASE_URL}${WEBHOOK_PATH_PREFIX}/${pathToken}`, connectionTest: result };
  }

  /** Changes some credential fields (each optional; the rest stay): test then swap (plan 4.1, 4.4 and 15.2). */
  async changeCredentials(id: string, input: { version: number; credentials: unknown }, actor: AuditActor): Promise<{ version: number; connectionTest: ConnectionTestCode }> {
    const manifest = await this.manifestOf(id);
    if (manifest.account.fields.length === 0) throw unprocessable('no_credentials_to_change', 'This kind of account has no credentials to change');
    const checked = checkCredentials(manifest.account, input.credentials, { partial: true });
    if (!checked.ok) throw unprocessable('credentials_invalid', 'The account details are not valid', { fields: checked.fields });
    return this.storeSecretsChange(id, input.version, { credentials: checked.values }, actor, 'payments.providerAccount.credentialsChanged');
  }

  /** Sets or changes the webhook signing secret the gateway issued (plan 4.1, 15.2). */
  async setWebhookSecret(id: string, input: { version: number; webhookSecret: unknown }, actor: AuditActor): Promise<{ version: number; connectionTest: ConnectionTestCode }> {
    const manifest = await this.manifestOf(id);
    if (manifest.account.webhookSecret.source !== 'entered') throw unprocessable('webhook_secret_generated', 'This kind of account makes its own webhook secret');
    if (!webhookSecretValid(manifest.account, input.webhookSecret)) throw unprocessable('credentials_invalid', 'The account details are not valid', { fields: ['webhookSecret'] });
    return this.storeSecretsChange(id, input.version, { webhookSecret: input.webhookSecret }, actor, 'payments.providerAccount.webhookSecretChanged');
  }

  private async manifestOf(id: string) {
    const row = await this.prisma.providerAccount.findUnique({ where: { id }, select: { adapterKey: true } });
    if (!row) throw notFound('provider_account_not_found', 'Payment account not found');
    const manifest = this.gateway.registry.get(row.adapterKey);
    if (!manifest || manifest.manifest.status === 'planned') throw conflict('adapter_unavailable', 'This payment account cannot be used for that here');
    return manifest.manifest;
  }

  private async storeSecretsChange(id: string, version: number, patch: { credentials?: Record<string, string>; webhookSecret?: string }, actor: AuditActor, action: string): Promise<{ version: number; connectionTest: ConnectionTestCode }> {
    const current = await this.prisma.providerAccount.findUniqueOrThrow({ where: { id }, select: { version: true } });
    if (current.version !== version) throw conflict('version_conflict', 'Someone else changed this account. Reload and try again.');
    const prepared = await this.gateway.prepareSecretsChange(id, patch);
    if (!secretsChangeAcceptable(prepared.result, { setsWebhookSecret: patch.webhookSecret !== undefined, hasWebhookSecret: prepared.hadWebhookSecret })) {
      throw unprocessable('connection_test_failed', 'The new details did not pass the connection test; nothing was changed', { connectionTest: prepared.result });
    }
    return runTransaction(this.prisma, async (tx) => {
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now` as [{ now: Date }];
      // Compare-and-set on the version and on the credentials the test was based on (plan 4.1, 15.4).
      const n = await tx.providerAccount.updateMany({
        where: { id, version, credentialsChangedAt: prepared.basedOn },
        data: { ...prepared.sealed, credentialsChangedAt: now, lastConnectionTestAt: now, lastConnectionTestResult: prepared.result, version: { increment: 1 } },
      });
      if (n.count !== 1) throw conflict('version_conflict', 'Someone else changed this account. Reload and try again.');
      // New details that tested ok: the account's health starts clean (plan 4.2, 15.6); the test itself wrote none.
      if (prepared.result === 'ok') await this.health.reset(tx, id);
      await this.audit.record(tx, {
        actor, action, entityType: 'ProviderAccount', entityId: id, model: 'ProviderAccount',
        before: { credentialsCiphertext: 'a', ...(patch.webhookSecret !== undefined ? { webhookSecretCiphertext: 'a' } : {}), lastConnectionTestResult: null },
        after: { credentialsCiphertext: 'b', ...(patch.webhookSecret !== undefined ? { webhookSecretCiphertext: 'b' } : {}), lastConnectionTestResult: prepared.result },
        context: { fields: Object.keys(patch.credentials ?? {}).sort().join(':') || 'webhookSecret' },
      });
      return { version: version + 1, connectionTest: prepared.result };
    });
  }

  // ---- The console (tasks 3.1, 3.3, 3.4): development and CI tools, unchanged ----

  /**
   * The account bank transfers are recorded against (task 3.4): adapter `manual`, test mode, created from the console.
   * It has no gateway, so its credentials are empty and its webhook secret is never used; they exist because every
   * account has them and because the rest of the code treats all accounts alike.
   */
  async createManualAccount(input: { displayName?: string; actor?: AuditActor } = {}): Promise<{ id: string }> {
    const id = randomUUID();
    const creds = this.box.encrypt(JSON.stringify({}), credentialsAad(id));
    const secret = this.box.encrypt(randomBytes(32).toString('hex'), webhookSecretAad(id));
    const displayName = (input.displayName ?? 'Bank transfer (manual)').slice(0, 100);
    // The adapter's own test (no gateway), recorded at the change time (task 4.1); the panel's test also checks the methods.
    const tested = await this.gateway.testCandidate(MANUAL_KEY, 'test', { credentials: {}, webhookSecret: 'unused' });
    await this.prisma.$transaction(async (tx) => {
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now` as [{ now: Date }];
      const created = await tx.providerAccount.create({
        data: {
          id, adapterKey: MANUAL_KEY, displayName, mode: 'test', status: 'active', credentialsChangedAt: now, lastConnectionTestAt: now, lastConnectionTestResult: tested,
          credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
          webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
          webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, randomBytes(32).toString('base64url')), createdById: input.actor?.id ?? null,
        },
        select: { adapterKey: true, createdAt: true },
      });
      // Its default routing rules, with its createdAt so the order of task 3.1 holds (plan 4.2, sections 6 and 15.7).
      await insertDefaultRules(tx, id, this.gateway.registry.get(created.adapterKey)!.manifest, created.createdAt);
      await this.audit.record(tx, {
        actor: input.actor ?? SYSTEM_ACTOR, action: 'payments.providerAccount.created', entityType: 'ProviderAccount', entityId: id, model: 'ProviderAccount',
        after: { adapterKey: MANUAL_KEY, displayName, mode: 'test', status: 'active', credentialsCiphertext: creds.ciphertext, webhookSecretCiphertext: secret.ciphertext, webhookPathTokenHash: 'x' },
      });
    });
    return { id };
  }

  async createSimulatorAccount(input: { displayName?: string; actor?: AuditActor } = {}): Promise<{ id: string; webhookUrl: string }> {
    if (!TEST_ADAPTER_ENVS.includes(this.config.APP_ENV)) throw new AppError('simulator_not_allowed_here', 'Simulator accounts exist only in development, test and ci');
    const id = randomUUID();
    const apiKey = `sim_test_${randomBytes(18).toString('hex')}`;
    const webhookSecret = randomBytes(32).toString('hex');
    const pathToken = randomBytes(32).toString('base64url');
    const creds = this.box.encrypt(JSON.stringify({ apiKey }), credentialsAad(id));
    const secret = this.box.encrypt(webhookSecret, webhookSecretAad(id));
    const displayName = (input.displayName ?? 'Payment simulator').slice(0, 100);
    // The simulator's test is local (no network): recorded at the change time, as from the panel (task 4.1).
    const tested = await this.gateway.testCandidate(SIMULATOR_KEY, 'test', { credentials: { apiKey }, webhookSecret });
    await this.prisma.$transaction(async (tx) => {
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now` as [{ now: Date }];
      const created = await tx.providerAccount.create({
        data: {
          id, adapterKey: SIMULATOR_KEY, displayName, mode: 'test', status: 'active', credentialsChangedAt: now, lastConnectionTestAt: now, lastConnectionTestResult: tested,
          credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
          webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
          webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, pathToken), createdById: input.actor?.id ?? null,
        },
        select: { adapterKey: true, createdAt: true },
      });
      // Its default routing rules, with its createdAt so the order of task 3.1 holds (plan 4.2, sections 6 and 15.7).
      await insertDefaultRules(tx, id, this.gateway.registry.get(created.adapterKey)!.manifest, created.createdAt);
      await this.audit.record(tx, {
        actor: input.actor ?? SYSTEM_ACTOR, action: 'payments.providerAccount.created', entityType: 'ProviderAccount', entityId: id, model: 'ProviderAccount',
        after: { adapterKey: SIMULATOR_KEY, displayName, mode: 'test', status: 'active', credentialsCiphertext: creds.ciphertext, webhookSecretCiphertext: secret.ciphertext, webhookPathTokenHash: 'x' },
      });
    });
    return { id, webhookUrl: `${this.config.API_BASE_URL}${WEBHOOK_PATH_PREFIX}/${pathToken}` };
  }

  /**
   * A Stripe account in test mode (task 3.3), from the console only: its keys come from Oscar's sandbox, read from
   * environment variables by the caller, never from arguments. Never in production; never a live key. Accounts in the
   * panel are task 4.1. The keys are encrypted at once and never shown again; the webhook URL is printed once.
   */
  async createStripeTestAccount(input: { displayName?: string; secretKey: string; webhookSecret: string; actor?: AuditActor }): Promise<{ id: string; webhookUrl: string }> {
    if (this.config.APP_ENV === 'production') throw new AppError('stripe_test_account_not_here', 'Stripe test accounts are not created in production');
    if (!STRIPE_TEST_KEY.test(input.secretKey)) throw new AppError('stripe_test_key_required', 'STRIPE_TEST_SECRET_KEY must be a Stripe test-mode secret or restricted key');
    if (!STRIPE_WEBHOOK_SECRET.test(input.webhookSecret)) throw new AppError('stripe_webhook_secret_required', 'STRIPE_TEST_WEBHOOK_SECRET must be the endpoint signing secret (whsec_…)');
    const id = randomUUID();
    const pathToken = randomBytes(32).toString('base64url');
    const creds = this.box.encrypt(JSON.stringify({ secretKey: input.secretKey }), credentialsAad(id));
    const secret = this.box.encrypt(input.webhookSecret, webhookSecretAad(id));
    const displayName = (input.displayName ?? 'Stripe (test mode)').slice(0, 100);
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.providerAccount.create({
        data: {
          id, adapterKey: STRIPE_KEY, displayName, mode: 'test', status: 'active',
          credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
          webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
          webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, pathToken), createdById: input.actor?.id ?? null,
        },
        select: { adapterKey: true, createdAt: true },
      });
      // Its default routing rules, with its createdAt so the order of task 3.1 holds (plan 4.2, sections 6 and 15.7).
      await insertDefaultRules(tx, id, this.gateway.registry.get(created.adapterKey)!.manifest, created.createdAt);
      await this.audit.record(tx, {
        actor: input.actor ?? SYSTEM_ACTOR, action: 'payments.providerAccount.created', entityType: 'ProviderAccount', entityId: id, model: 'ProviderAccount',
        after: { adapterKey: STRIPE_KEY, displayName, mode: 'test', status: 'active', credentialsCiphertext: creds.ciphertext, webhookSecretCiphertext: secret.ciphertext, webhookPathTokenHash: 'x' },
      });
    });
    return { id, webhookUrl: `${this.config.API_BASE_URL}${WEBHOOK_PATH_PREFIX}/${pathToken}` };
  }
}

/** A Stripe test-mode secret or restricted key; a live key never matches. */
export const STRIPE_TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]{10,250}$/;
export const STRIPE_WEBHOOK_SECRET = /^whsec_[A-Za-z0-9]{10,250}$/;
