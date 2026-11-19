import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AppEnv } from '@mt/shared';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import type { AppConfig } from '../../../platform/config/config';
import type { SecretBox } from '../../../platform/crypto/secret-box';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { ApiError } from '../../../platform/http/api-error';
import { SECRET_BOX } from '../../../platform/auth/staff-auth.service';
import type { AdapterManifest, PaymentModeName, PaymentProvider, ProviderContext, WebhookVerification } from './provider';
import { PROVIDER_ERROR_CODES, ProviderError } from './provider';
import { ProviderHealthService } from './provider-health.service';
import { PaymentAdapterRegistry } from './registry';
import { countsForBreaker } from './routing-rules';

/** The environments where a test-only adapter (the simulator) may run: a closed list (plan 3.1, section 14, point 14). */
export const TEST_ADAPTER_ENVS: readonly AppEnv[] = ['development', 'test', 'ci'];

/** `refund` (task 3.3) is allowed on paused and retired accounts (plan 0.1, 6.4), never live outside production. */
export type GatewayOperation = 'create' | 'retrieve' | 'cancel' | 'refund' | 'webhook' | 'test_connection';

export interface AccountForCall {
  id: string;
  adapterKey: string;
  mode: PaymentModeName;
  status: 'active' | 'paused' | 'retired' | 'archived';
}

/** Columns of provider_accounts that anything but this file may read: never a secret. */
export const ACCOUNT_PUBLIC_SELECT = { id: true, adapterKey: true, mode: true, status: true } as const;

/** The mode of money this environment counts and charges: live only in production (plan 0.1, P11). */
export const modeForEnv = (env: AppEnv): PaymentModeName => (env === 'production' ? 'live' : 'test');

/**
 * Whether a call to a gateway may happen, before any credential is decrypted (plan 3.1, section 2.4). Null means
 * allowed; otherwise the code of the refusal. There is no flag or setting that skips any of these rules.
 */
export function callBlockReason(account: AccountForCall, manifest: AdapterManifest | undefined, op: GatewayOperation, env: AppEnv): string | null {
  if (!manifest || manifest.status === 'planned') return 'adapter_unavailable';
  if (account.mode === 'live' && env !== 'production') return 'live_call_blocked_outside_production';
  if (account.mode === 'live' && (manifest.status !== 'verified' || manifest.testOnly)) return 'adapter_not_verified_for_live';
  if (manifest.testOnly && !TEST_ADAPTER_ENVS.includes(env)) return 'test_adapter_blocked_in_environment';
  if ((op === 'create' || op === 'refund') && account.mode !== modeForEnv(env)) return 'account_mode_not_for_environment';
  if (op === 'create' && account.status !== 'active') return 'account_not_accepting_charges';
  return null;
}

const CALL_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError('provider_timeout', true)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * What a connection test can report (plan 4.1, 4.2 and 15.8): `ok` or a code from this closed list. A code an adapter
 * returns that is not in it becomes `provider_rejected`; the gateway's own words never reach us.
 */
export const CONNECTION_TEST_CODES = ['ok', ...PROVIDER_ERROR_CODES, 'webhook_secret_missing', 'manual_instructions_invalid', 'credentials_unreadable'] as const;
export type ConnectionTestCode = (typeof CONNECTION_TEST_CODES)[number];
export const normaliseTestCode = (code: string): ConnectionTestCode => ((CONNECTION_TEST_CODES as readonly string[]).includes(code) ? (code as ConnectionTestCode) : 'provider_rejected');

/** Credentials being set up or changed, not stored yet (plan 4.1, section 4.1, step 3). Test mode only. */
export interface CandidateSecrets {
  credentials: Readonly<Record<string, string>>;
  /** Null while an entered webhook secret has not been set. */
  webhookSecret: string | null;
}

/** AAD of each secret: bound to the account and to its purpose, so a ciphertext copied elsewhere does not decrypt. */
export const credentialsAad = (accountId: string) => `provider_account:${accountId}:credentials`;
export const webhookSecretAad = (accountId: string) => `provider_account:${accountId}:webhook_secret`;

/**
 * The only door to a payment gateway (plan 3.1, section 2.4): reads the account without secrets, applies the rules,
 * then decrypts the credentials for this one call, with a time limit, and turns any failure into a ProviderError code.
 * It is the only code that selects the credential columns (checked by a test).
 */
@Injectable()
export class ProviderGateway {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PaymentAdapterRegistry) readonly registry: PaymentAdapterRegistry,
    // Gateway health (task 4.2): fed only by calls to stored accounts, never by tests of candidate credentials.
    @Optional() @Inject(ProviderHealthService) private readonly health?: ProviderHealthService,
  ) {}

  get env(): AppEnv {
    return this.config.APP_ENV;
  }

  get mode(): PaymentModeName {
    return modeForEnv(this.config.APP_ENV);
  }

  async call<T>(accountId: string, op: GatewayOperation, fn: (provider: PaymentProvider, ctx: ProviderContext) => Promise<T>): Promise<T> {
    const account = await this.prisma.providerAccount.findUnique({ where: { id: accountId }, select: ACCOUNT_PUBLIC_SELECT });
    if (!account) throw new ApiError(409, 'provider_account_missing', 'The payment account no longer exists');
    const provider = await this.allow(account, op);
    const { ctx } = await this.context(account);
    const startedAt = new Date();
    try {
      const result = await withTimeout(fn(provider, ctx), CALL_TIMEOUT_MS);
      await this.health?.success(account.id, startedAt);
      return result;
    } catch (err) {
      // Never the gateway's message: it can carry credentials or the payer's details.
      const e = err instanceof ProviderError ? err : new ProviderError('provider_unavailable', true);
      await this.noteFailure(account.id, e.code);
      throw e;
    }
  }

  private async noteFailure(accountId: string, code: string): Promise<void> {
    if (countsForBreaker(code)) await this.health?.failure(accountId, code);
  }

  /** Verifies a webhook with the secret of the account that received it (no network). */
  async verifyWebhook(account: AccountForCall, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): Promise<WebhookVerification> {
    const provider = await this.allow(account, 'webhook');
    const { ctx } = await this.context(account);
    // No secret entered yet (task 4.1): nothing can be verified, so nothing is accepted; the adapter is not asked.
    if (ctx.webhookSecret === '') return { ok: false, code: 'bad_signature' };
    try {
      return provider.verifyWebhook(ctx, rawBody, headers, now);
    } catch {
      return { ok: false, code: 'malformed' };
    }
  }

  /**
   * The connection test of a stored account (plan 4.1, sections 4.2 and 15.4): allowed on every status under the same
   * rules as any call. Returns the code and the `credentialsChangedAt` read in the same SELECT as the ciphertexts, so the
   * caller records the result only for the credentials that were tested.
   */
  async testConnection(accountId: string): Promise<{ result: ConnectionTestCode; credentialsChangedAt: Date }> {
    const account = await this.prisma.providerAccount.findUnique({ where: { id: accountId }, select: ACCOUNT_PUBLIC_SELECT });
    if (!account) throw new ApiError(404, 'provider_account_not_found', 'Payment account not found');
    const provider = await this.allow(account, 'test_connection');
    // One read: the change time that goes with the result is the one of the ciphertexts tried, even when they fail.
    const row = await this.readSecrets(account.id);
    let ctx: ProviderContext;
    try {
      ctx = this.open(account, row);
    } catch {
      return { result: 'credentials_unreadable', credentialsChangedAt: row.credentialsChangedAt };
    }
    const startedAt = new Date();
    const result = await this.runTest(provider, ctx);
    // A stored account's test feeds its health (plan 4.2, 15.6); candidate tests below never do.
    if (result === 'ok') await this.health?.success(account.id, startedAt);
    else await this.noteFailure(account.id, result);
    return { result, credentialsChangedAt: row.credentialsChangedAt };
  }

  /**
   * The connection test of credentials that are not stored yet (plan 4.1, sections 4.1 and 4.4): the same rules as a call
   * on a paused test-mode account of that adapter, applied before the provider is touched; the context is built from the
   * candidate values, never from the database. Only `mode: 'test'` exists (plan 4.1, 15.8).
   */
  async testCandidate(adapterKey: string, mode: 'test', candidate: CandidateSecrets): Promise<ConnectionTestCode> {
    const account: AccountForCall = { id: randomUUID(), adapterKey, mode, status: 'paused' };
    const provider = await this.allow(account, 'test_connection');
    const ctx: ProviderContext = { accountId: account.id, mode, credentials: Object.freeze({ ...candidate.credentials }), webhookSecret: candidate.webhookSecret ?? '' };
    return this.runTest(provider, ctx);
  }

  /**
   * A change of a stored account's secrets (plan 4.1, 4.4 and 15.2): the current values are decrypted here, the fields
   * sent replace theirs, the result is tested as a candidate and handed back already encrypted, with the
   * `credentialsChangedAt` it was based on. Plaintext never leaves this class. Nothing is written: the caller stores it,
   * comparing `basedOn`, only if the test allows.
   */
  async prepareSecretsChange(accountId: string, patch: { credentials?: Readonly<Record<string, string>>; webhookSecret?: string }): Promise<{
    result: ConnectionTestCode; basedOn: Date; hadWebhookSecret: boolean;
    sealed: { credentialsCiphertext: string; credentialsKeyVersion: number; webhookSecretCiphertext: string | null; webhookKeyVersion: number | null };
  }> {
    const account = await this.prisma.providerAccount.findUnique({ where: { id: accountId }, select: ACCOUNT_PUBLIC_SELECT });
    if (!account) throw new ApiError(404, 'provider_account_not_found', 'Payment account not found');
    const provider = await this.allow(account, 'test_connection');
    let read: { ctx: ProviderContext; credentialsChangedAt: Date };
    try {
      read = await this.context(account);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(409, 'credentials_unreadable', 'The stored credentials cannot be read with the configured key');
    }
    const credentials = { ...read.ctx.credentials, ...(patch.credentials ?? {}) };
    const webhookSecret = patch.webhookSecret ?? read.ctx.webhookSecret;
    const ctx: ProviderContext = { accountId, mode: account.mode, credentials: Object.freeze(credentials), webhookSecret };
    const result = await this.runTest(provider, ctx);
    const creds = this.box.encrypt(JSON.stringify(credentials), credentialsAad(accountId));
    const secret = webhookSecret === '' ? null : this.box.encrypt(webhookSecret, webhookSecretAad(accountId));
    return {
      result, basedOn: read.credentialsChangedAt, hadWebhookSecret: read.ctx.webhookSecret !== '',
      sealed: { credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion, webhookSecretCiphertext: secret?.ciphertext ?? null, webhookKeyVersion: secret?.keyVersion ?? null },
    };
  }

  private async runTest(provider: PaymentProvider, ctx: ProviderContext): Promise<ConnectionTestCode> {
    try {
      const r = await withTimeout(provider.testConnection(ctx), CALL_TIMEOUT_MS);
      return r.ok ? 'ok' : normaliseTestCode(r.code);
    } catch (err) {
      return err instanceof ProviderError ? err.code : 'provider_unavailable';
    }
  }

  signatureHeaders(adapterKey: string): readonly string[] {
    return this.registry.get(adapterKey)?.signatureHeaders ?? [];
  }

  private async allow(account: AccountForCall, op: GatewayOperation): Promise<PaymentProvider> {
    const provider = this.registry.get(account.adapterKey);
    const reason = callBlockReason(account, provider?.manifest, op, this.config.APP_ENV);
    if (reason) {
      await this.prisma.$transaction((tx) => this.audit.record(tx, {
        actor: SYSTEM_ACTOR, action: 'payments.gateway.call_blocked', entityType: 'ProviderAccount', entityId: account.id,
        context: { reason, operation: op, mode: account.mode, adapterKey: account.adapterKey },
      }));
      throw new ApiError(409, reason, 'This payment account cannot be used for that here');
    }
    return provider!;
  }

  /** Decrypts the account's secrets for one call; `credentialsChangedAt` comes from the same row read (plan 4.1, 15.4). */
  private async context(account: AccountForCall): Promise<{ ctx: ProviderContext; credentialsChangedAt: Date }> {
    const secrets = await this.readSecrets(account.id);
    return { ctx: this.open(account, secrets), credentialsChangedAt: secrets.credentialsChangedAt };
  }

  private readSecrets(accountId: string) {
    return this.prisma.providerAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { credentialsCiphertext: true, credentialsKeyVersion: true, webhookSecretCiphertext: true, webhookKeyVersion: true, credentialsChangedAt: true },
    });
  }

  private open(account: AccountForCall, secrets: Awaited<ReturnType<ProviderGateway['readSecrets']>>): ProviderContext {
    const credentials = JSON.parse(this.box.decrypt(secrets.credentialsCiphertext, secrets.credentialsKeyVersion, credentialsAad(account.id))) as Record<string, string>;
    const webhookSecret = secrets.webhookSecretCiphertext === null || secrets.webhookKeyVersion === null
      ? ''
      : this.box.decrypt(secrets.webhookSecretCiphertext, secrets.webhookKeyVersion, webhookSecretAad(account.id));
    return { accountId: account.id, mode: account.mode, credentials: Object.freeze(credentials), webhookSecret };
  }
}
