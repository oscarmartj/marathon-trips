import type { PrismaClient } from '../../generated/prisma/client';
import type { AppConfig } from '../config/config';
import { SecretBox } from '../crypto/secret-box';
import { hashPassword } from './passwords';
import { newRecoveryCode, recoveryCodeHash } from './tokens';
import { newTotpSecret, totpUri } from './totp';
import { randomBytes } from 'node:crypto';

export const DEMO_OWNER_EMAIL = 'owner@example.test';
const DEMO_ENVS = ['development', 'test', 'ci'];

export interface CreatedStaff {
  id: string;
  email: string;
  password: string;
  secret: string;
  uri: string;
  recoveryCodes: string[];
}

/**
 * A fully enrolled owner with random credentials, for the demo seed (development, test, ci) and the end-to-end set-up
 * (test, ci). Never available in staging or production: the first real owner is created with `staff:create`.
 */
export async function createEnrolledOwner(prisma: PrismaClient, config: AppConfig, email: string): Promise<CreatedStaff> {
  if (!DEMO_ENVS.includes(config.APP_ENV)) throw new Error('Enrolled staff with generated credentials exist only in development, test and ci');
  const password = randomBytes(12).toString('base64url');
  const secret = newTotpSecret();
  const recoveryCodes = Array.from({ length: 10 }, () => newRecoveryCode());
  const box = new SecretBox(config.APP_ENCRYPTION_KEY, config.APP_ENCRYPTION_KEY_VERSION);
  const passwordHash = await hashPassword(password);
  const id = await prisma.$transaction(async (tx) => {
    const role = await tx.role.upsert({
      where: { key: 'owner' }, update: {},
      create: { key: 'owner', name: 'Owner', description: 'Every permission. Cannot be edited.', isSystem: true },
    });
    const user = await tx.user.create({ data: { kind: 'staff', email, emailVerifiedAt: new Date() }, select: { id: true } });
    const enc = box.encrypt(secret, `totp:${user.id}`);
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, totpSecretCiphertext: enc.ciphertext, totpKeyVersion: enc.keyVersion, totpEnabledAt: new Date() } });
    await tx.recoveryCode.createMany({ data: recoveryCodes.map((c) => ({ userId: user.id, codeHash: recoveryCodeHash(config.AUTH_HMAC_KEY, c) })) });
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    await tx.auditLog.create({ data: { actorType: 'system', action: 'access.user.seeded', entityType: 'User', entityId: user.id, changes: { kind: { before: null, after: 'staff' } } } });
    return user.id;
  });
  return { id, email, password, secret, uri: totpUri(secret, email), recoveryCodes };
}

export const demoStaffAllowed = (appEnv: string): boolean => DEMO_ENVS.includes(appEnv);
