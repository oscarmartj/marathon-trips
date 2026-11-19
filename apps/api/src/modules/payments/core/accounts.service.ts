import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import type { AppConfig } from '../../../platform/config/config';
import type { SecretBox } from '../../../platform/crypto/secret-box';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { SECRET_BOX } from '../../../platform/auth/staff-auth.service';
import { AppError } from '../../../platform/errors/safe-error';
import { SIMULATOR_KEY } from '../adapters/simulator/simulator';
import { STRIPE_KEY } from '../adapters/stripe/stripe';
import { TEST_ADAPTER_ENVS, credentialsAad, webhookSecretAad } from './gateway';
import { WEBHOOK_PATH_PREFIX, webhookPathTokenHash } from './webhooks.service';

/** What the panel and the console may see of an account: never a secret column. */
export const ACCOUNT_VIEW_SELECT = { id: true, adapterKey: true, displayName: true, mode: true, status: true, lastConnectionTestAt: true, lastConnectionTestResult: true, createdAt: true } as const;

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
  ) {}

  async createSimulatorAccount(input: { displayName?: string; actor?: AuditActor } = {}): Promise<{ id: string; webhookUrl: string }> {
    if (!TEST_ADAPTER_ENVS.includes(this.config.APP_ENV)) throw new AppError('simulator_not_allowed_here', 'Simulator accounts exist only in development, test and ci');
    const id = randomUUID();
    const apiKey = `sim_test_${randomBytes(18).toString('hex')}`;
    const webhookSecret = randomBytes(32).toString('hex');
    const pathToken = randomBytes(32).toString('base64url');
    const creds = this.box.encrypt(JSON.stringify({ apiKey }), credentialsAad(id));
    const secret = this.box.encrypt(webhookSecret, webhookSecretAad(id));
    const displayName = (input.displayName ?? 'Payment simulator').slice(0, 100);
    await this.prisma.$transaction(async (tx) => {
      await tx.providerAccount.create({
        data: {
          id, adapterKey: SIMULATOR_KEY, displayName, mode: 'test', status: 'active',
          credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
          webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
          webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, pathToken), createdById: input.actor?.id ?? null,
        },
      });
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
      await tx.providerAccount.create({
        data: {
          id, adapterKey: STRIPE_KEY, displayName, mode: 'test', status: 'active',
          credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
          webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
          webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, pathToken), createdById: input.actor?.id ?? null,
        },
      });
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
