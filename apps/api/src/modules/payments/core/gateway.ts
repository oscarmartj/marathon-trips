import { Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '@mt/shared';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import type { AppConfig } from '../../../platform/config/config';
import type { SecretBox } from '../../../platform/crypto/secret-box';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { ApiError } from '../../../platform/http/api-error';
import { SECRET_BOX } from '../../../platform/auth/staff-auth.service';
import type { AdapterManifest, PaymentModeName, PaymentProvider, ProviderContext, WebhookVerification } from './provider';
import { ProviderError } from './provider';
import { PaymentAdapterRegistry } from './registry';

/** The environments where a test-only adapter (the simulator) may run: a closed list (plan 3.1, section 14, point 14). */
export const TEST_ADAPTER_ENVS: readonly AppEnv[] = ['development', 'test', 'ci'];

export type GatewayOperation = 'create' | 'retrieve' | 'cancel' | 'webhook' | 'test_connection';

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
  if (op === 'create' && account.mode !== modeForEnv(env)) return 'account_mode_not_for_environment';
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
    const ctx = await this.context(account);
    try {
      return await withTimeout(fn(provider, ctx), CALL_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      // Never the gateway's message: it can carry credentials or the payer's details.
      throw new ProviderError('provider_unavailable', true);
    }
  }

  /** Verifies a webhook with the secret of the account that received it (no network). */
  async verifyWebhook(account: AccountForCall, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): Promise<WebhookVerification> {
    const provider = await this.allow(account, 'webhook');
    const ctx = await this.context(account);
    try {
      return provider.verifyWebhook(ctx, rawBody, headers, now);
    } catch {
      return { ok: false, code: 'malformed' };
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

  private async context(account: AccountForCall): Promise<ProviderContext> {
    const secrets = await this.prisma.providerAccount.findUniqueOrThrow({
      where: { id: account.id },
      select: { credentialsCiphertext: true, credentialsKeyVersion: true, webhookSecretCiphertext: true, webhookKeyVersion: true },
    });
    const credentials = JSON.parse(this.box.decrypt(secrets.credentialsCiphertext, secrets.credentialsKeyVersion, credentialsAad(account.id))) as Record<string, string>;
    const webhookSecret = this.box.decrypt(secrets.webhookSecretCiphertext, secrets.webhookKeyVersion, webhookSecretAad(account.id));
    return { accountId: account.id, mode: account.mode, credentials: Object.freeze(credentials), webhookSecret };
  }
}
