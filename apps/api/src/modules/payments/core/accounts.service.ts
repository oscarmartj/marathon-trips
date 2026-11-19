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
    await this.prisma.$transaction(async (tx) => {
      await tx.providerAccount.create({
        data: {
          id, adapterKey: MANUAL_KEY, displayName, mode: 'test', status: 'active',
          credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
          webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
          webhookPathTokenHash: webhookPathTokenHash(this.config.AUTH_HMAC_KEY, randomBytes(32).toString('base64url')), createdById: input.actor?.id ?? null,
        },
      });
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
}
