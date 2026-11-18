import { Inject, Injectable } from '@nestjs/common';
import { brand } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuditActor, AuditService, NIL_UUID } from '../audit/audit.service';
import type { AppConfig } from '../config/config';
import { SecretBox } from '../crypto/secret-box';
import { emailHash } from '../crypto/hmac';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { OutboxService } from '../events/outbox.service';
import { ApiError, tooManyRequests, unauthorised, unprocessable } from '../http/api-error';
import { SATURATION_SECONDS, UnknownAccountDelay, claimAccountAttempt, refundAccountAttempt } from './attempt-limiter';
import { guessablePassword, hashPassword, verifyPassword } from './passwords';
import type { RequestMeta } from './request-meta';
import { SessionService } from './session.service';
import { looksLikeToken, newRecoveryCode, newToken, recoveryCodeHash, tokenHash } from './tokens';
import { newTotpSecret, totpUri, verifyTotp } from './totp';
import { revokeOwnerApiKeys } from '../integrations/revoke-owner-keys';

export const SECRET_BOX = Symbol('SECRET_BOX');
export const MFA_STEP_MS = 5 * 60_000;
export const ENROLMENT_MS = 24 * 3600_000;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_STEP_UP_FAILURES = 5;
export const RECOVERY_CODE_COUNT = 10;

const invalidCredentials = () => unauthorised('invalid_credentials', 'The email or password is not right');
const invalidCode = () => unauthorised('invalid_code', 'That code is not right');
const mfaExpired = () => unauthorised('mfa_expired', 'Sign in again to continue');
const enrolmentInvalid = () => new ApiError(400, 'enrolment_link_invalid', 'This set-up link is not valid any more. Ask an owner for a new one.');

const totpAad = (userId: string) => `totp:${userId}`;

/**
 * Staff sign-in (plan 4.2 and section 10 of the 0.3 plan): password, then TOTP or a recovery code, then a session.
 * No session exists before the second factor. Enrolment and reset go through a one-time link.
 */
@Injectable()
export class StaffAuthService {
  private readonly unknown = new UnknownAccountDelay();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  private actor(userId: string | null, meta?: { requestId?: string }): AuditActor {
    return { type: userId ? 'staff' : 'system', id: userId, requestId: meta?.requestId ?? null };
  }

  private async auditFailure(userId: string | null, action: string, reason: string, requestId?: string): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.audit.record(tx, { actor: { type: 'system', id: null, requestId: requestId ?? null }, action, entityType: 'User', entityId: userId ?? NIL_UUID, context: { reason } }),
    );
  }

  /** Step 1. Always one argon2 verification; unknown and incomplete accounts answer exactly like a wrong password. */
  async signIn(email: string, password: string, requestId?: string): Promise<{ mfaToken: string; maxAgeSeconds: number }> {
    // S-06: while the unknown-address table is full, every address without a count there is refused, known ones too.
    if (this.unknown.saturated(emailHash(this.config.AUTH_HMAC_KEY, email))) throw tooManyRequests(SATURATION_SECONDS);
    const user = await this.prisma.user.findUnique({
      where: { kind_email: { kind: 'staff', email } },
      select: { id: true, status: true, passwordHash: true, totpEnabledAt: true },
    });
    if (user) await claimAccountAttempt(this.prisma, user.id);
    else this.unknown.claim(emailHash(this.config.AUTH_HMAC_KEY, email));
    const passwordOk = await verifyPassword(user?.passwordHash ?? null, password);
    if (!user || !passwordOk || user.status !== 'active' || !user.totpEnabledAt) {
      await this.auditFailure(user?.id ?? null, 'auth.staff.signInFailed', user ? 'bad_password_or_inactive' : 'unknown_account', requestId);
      throw invalidCredentials();
    }
    await refundAccountAttempt(this.prisma, user.id);
    const token = newToken();
    await this.prisma.loginToken.create({
      data: { purpose: 'staff_mfa', email, userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + MFA_STEP_MS) },
    });
    return { mfaToken: token, maxAgeSeconds: MFA_STEP_MS / 1000 };
  }

  /** Step 2 (G2). Counts the attempt on the account and on the step token before checking the code. */
  async verifySecondFactor(mfaToken: string | undefined, input: { code?: string; recoveryCode?: string }, meta: RequestMeta, requestId?: string) {
    if (!looksLikeToken(mfaToken)) throw mfaExpired();
    const now = new Date();
    const step = await this.prisma.loginToken.findUnique({ where: { tokenHash: tokenHash(mfaToken) }, select: { id: true, purpose: true, userId: true, consumedAt: true, expiresAt: true } });
    if (!step || step.purpose !== 'staff_mfa' || !step.userId || step.consumedAt || step.expiresAt <= now) throw mfaExpired();
    const userId = step.userId;
    await claimAccountAttempt(this.prisma, userId, now);
    const counted = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE login_tokens SET attempts = attempts + 1
      WHERE id = ${step.id}::uuid AND attempts < ${MAX_CODE_ATTEMPTS} AND "consumedAt" IS NULL AND "expiresAt" > ${now}::timestamptz
      RETURNING id`;
    if (counted.length === 0) throw mfaExpired();

    const method = input.code ? 'totp' : 'recovery_code';
    const ok = input.code ? await this.acceptTotp(userId, input.code, now) : await this.acceptRecoveryCode(userId, input.recoveryCode ?? '', now);
    if (!ok) {
      await this.auditFailure(userId, 'auth.staff.secondFactorFailed', method, requestId);
      throw invalidCode();
    }

    return this.prisma.$transaction(async (tx) => {
      const consumed = await tx.loginToken.updateMany({ where: { id: step.id, consumedAt: null }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw mfaExpired();
      // G2: the account may have been disabled or reset while the code was being typed.
      const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true, totpEnabledAt: true } });
      if (!user || user.status !== 'active' || !user.totpEnabledAt) throw mfaExpired();
      await tx.user.update({ where: { id: userId }, data: { failedLoginCount: 0, nextLoginAllowedAt: null, lastLoginAt: now } });
      // A recovery code signs in but never counts as a fresh TOTP check: step-up stays closed until a real code.
      const session = await this.sessions.create(tx, { userId, kind: 'staff', mfaVerifiedAt: method === 'totp' ? now : null, meta, now });
      const actor: AuditActor = { type: 'staff', id: userId, sessionId: session.sessionId, requestId: requestId ?? null };
      await this.audit.record(tx, { actor, action: 'auth.staff.signedIn', entityType: 'User', entityId: userId, context: { method } });
      await this.outbox.publish(tx, { type: 'auth.user.logged_in', aggregateType: 'User', aggregateId: userId, actorType: 'staff', actorId: userId, payload: { userId, sessionId: session.sessionId } });
      return session;
    });
  }

  /** Step-up (G3): account delay first, same anti-reuse, no recovery codes, five failures revoke the session. */
  async stepUp(userId: string, sessionId: string, code: string, requestId?: string): Promise<{ revoked: boolean; ok: boolean; session?: { token: string; maxAgeSeconds: number } }> {
    const now = new Date();
    await claimAccountAttempt(this.prisma, userId, now);
    if (await this.acceptTotp(userId, code, now)) {
      await refundAccountAttempt(this.prisma, userId);
      const session = await this.prisma.$transaction(async (tx) => {
        await tx.session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now, stepUpFailures: 0 } });
        await this.audit.record(tx, { actor: { type: 'staff', id: userId, sessionId, requestId: requestId ?? null }, action: 'auth.staff.steppedUp', entityType: 'Session', entityId: sessionId });
        // Task 8.5 (7.2.4): re-authenticated, so the cookie the check was made with stops working.
        return this.sessions.rotate(tx, sessionId, now);
      });
      return { revoked: false, ok: true, session };
    }
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ failures: number }>>`
        UPDATE sessions SET "stepUpFailures" = "stepUpFailures" + 1 WHERE id = ${sessionId}::uuid RETURNING "stepUpFailures" AS failures`;
      const revoked = (row?.failures ?? MAX_STEP_UP_FAILURES) >= MAX_STEP_UP_FAILURES;
      if (revoked) await this.sessions.revoke(tx, sessionId, 'step_up_failures');
      await this.audit.record(tx, {
        actor: { type: 'staff', id: userId, sessionId, requestId: requestId ?? null }, action: 'auth.staff.stepUpFailed', entityType: 'Session', entityId: sessionId,
        context: { revoked },
      });
      return { revoked, ok: false };
    });
  }

  /** Checks a TOTP code and records its time step with a compare-and-set, so a code is accepted once (T4). */
  private async acceptTotp(userId: string, code: string, now: Date): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { totpSecretCiphertext: true, totpKeyVersion: true, totpEnabledAt: true } });
    if (!user?.totpSecretCiphertext || !user.totpKeyVersion || !user.totpEnabledAt) return false;
    const secret = this.box.decrypt(user.totpSecretCiphertext, user.totpKeyVersion, totpAad(userId));
    const step = verifyTotp(secret, code, now.getTime());
    if (step === null) return false;
    const set = await this.prisma.$executeRaw`
      UPDATE users SET "totpLastUsedStep" = ${BigInt(step)}
      WHERE id = ${userId}::uuid AND ("totpLastUsedStep" IS NULL OR "totpLastUsedStep" < ${BigInt(step)})`;
    return set === 1;
  }

  private async acceptRecoveryCode(userId: string, code: string, now: Date): Promise<boolean> {
    const used = await this.prisma.recoveryCode.updateMany({
      where: { userId, codeHash: recoveryCodeHash(this.config.AUTH_HMAC_KEY, code), usedAt: null },
      data: { usedAt: now },
    });
    return used.count === 1;
  }

  async signOut(auth: { userId: string; sessionId: string }, requestId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revoke(tx, auth.sessionId, 'sign_out');
      await this.audit.record(tx, { actor: { type: 'staff', id: auth.userId, sessionId: auth.sessionId, requestId: requestId ?? null }, action: 'auth.staff.signedOut', entityType: 'Session', entityId: auth.sessionId });
    });
  }

  // ---- Enrolment (M3) ----

  /**
   * Issues a one-time set-up link (24 h) for a staff account and invalidates earlier set-up links and pending sign-in
   * steps. The link is returned once and never stored; only its hash is.
   */
  async issueEnrolment(tx: Prisma.TransactionClient, userId: string, email: string): Promise<{ url: string; expiresAt: Date }> {
    const now = new Date();
    await tx.loginToken.updateMany({ where: { userId, purpose: { in: ['staff_enrolment', 'staff_mfa'] }, consumedAt: null }, data: { consumedAt: now } });
    const token = newToken();
    const expiresAt = new Date(now.getTime() + ENROLMENT_MS);
    await tx.loginToken.create({ data: { purpose: 'staff_enrolment', email, userId, tokenHash: tokenHash(token), expiresAt } });
    return { url: `${new URL(this.config.WEB_ORIGIN).origin}/admin/enrol#token=${token}`, expiresAt };
  }

  /**
   * Reset: revoke every session, clear password, TOTP and recovery codes, clear the delay, and issue a new set-up
   * link. Used by the CLI (actor system) and by the panel (after AccessService.assertCanActOn).
   */
  async resetCredentials(tx: Prisma.TransactionClient, userId: string, actor: AuditActor, reason?: string | null): Promise<{ url: string; expiresAt: Date }> {
    const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, kind: true, passwordHash: true, totpSecretCiphertext: true } });
    if (before.kind !== 'staff') throw unprocessable('not_staff', 'Only staff accounts have credentials to reset');
    await this.sessions.revokeAllForUser(tx, userId, 'enrolment_reset');
    await revokeOwnerApiKeys(tx, this.audit, actor, userId, 'owner_reset');
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: null, totpSecretCiphertext: null, totpKeyVersion: null, totpEnabledAt: null, totpLastUsedStep: null, failedLoginCount: 0, nextLoginAllowedAt: null, version: { increment: 1 } },
    });
    await this.audit.record(tx, {
      actor, action: 'access.user.credentialsReset', entityType: 'User', entityId: userId, reason,
      before: { passwordHash: before.passwordHash, totpSecretCiphertext: before.totpSecretCiphertext },
      after: { passwordHash: null, totpSecretCiphertext: null },
    });
    return this.issueEnrolment(tx, userId, before.email);
  }

  private async liveEnrolment(token: string, now: Date) {
    const row = await this.prisma.loginToken.findUnique({ where: { tokenHash: tokenHash(token) }, select: { id: true, purpose: true, userId: true, consumedAt: true, expiresAt: true, attempts: true } });
    if (!row || row.purpose !== 'staff_enrolment' || !row.userId || row.consumedAt || row.expiresAt <= now || row.attempts >= MAX_CODE_ATTEMPTS) throw enrolmentInvalid();
    const user = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, email: true, kind: true, status: true, totpEnabledAt: true } });
    if (!user || user.kind !== 'staff' || user.status !== 'active' || user.totpEnabledAt) throw enrolmentInvalid();
    return { row, user };
  }

  /** Does not consume the link: generates a fresh pending TOTP secret (encrypted) and shows it to the link holder. */
  async startEnrolment(token: string): Promise<{ email: string; secret: string; uri: string }> {
    const { user } = await this.liveEnrolment(token, new Date());
    const secret = newTotpSecret();
    const enc = this.box.encrypt(secret, totpAad(user.id));
    await this.prisma.user.updateMany({
      where: { id: user.id, totpEnabledAt: null },
      data: { totpSecretCiphertext: enc.ciphertext, totpKeyVersion: enc.keyVersion },
    });
    return { email: user.email, secret, uri: totpUri(secret, user.email) };
  }

  /** Consumes the link: sets the password, confirms TOTP with a code and returns the recovery codes once. No session. */
  async completeEnrolment(token: string, password: string, code: string, requestId?: string): Promise<{ recoveryCodes: string[] }> {
    const now = new Date();
    const { row, user } = await this.liveEnrolment(token, now);
    // Task 8.5 (6.2.4): refused before the code is counted, so choosing a better password costs no attempt.
    if (guessablePassword(password, { email: user.email, brandName: brand.name })) {
      throw unprocessable('password_too_common', 'This password is too easy to guess. Choose a longer or less common one.');
    }
    const counted = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE login_tokens SET attempts = attempts + 1
      WHERE id = ${row.id}::uuid AND attempts < ${MAX_CODE_ATTEMPTS} AND "consumedAt" IS NULL AND "expiresAt" > ${now}::timestamptz
      RETURNING id`;
    if (counted.length === 0) throw enrolmentInvalid();
    const pending = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { totpSecretCiphertext: true, totpKeyVersion: true } });
    if (!pending.totpSecretCiphertext || !pending.totpKeyVersion) throw unprocessable('enrolment_not_started', 'Scan the code first');
    const step = verifyTotp(this.box.decrypt(pending.totpSecretCiphertext, pending.totpKeyVersion, totpAad(user.id)), code, now.getTime());
    if (step === null) throw unprocessable('invalid_code', 'That code is not right. Check the time on your phone and try again.');
    const passwordHash = await hashPassword(password);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.loginToken.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw enrolmentInvalid();
      const updated = await tx.user.updateMany({
        where: { id: user.id, status: 'active', totpEnabledAt: null, totpSecretCiphertext: pending.totpSecretCiphertext },
        data: { passwordHash, totpEnabledAt: now, totpLastUsedStep: BigInt(step), emailVerifiedAt: now, failedLoginCount: 0, nextLoginAllowedAt: null, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw enrolmentInvalid();
      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId: user.id, codeHash: recoveryCodeHash(this.config.AUTH_HMAC_KEY, c) })) });
      await this.audit.record(tx, {
        actor: { type: 'staff', id: user.id, requestId: requestId ?? null }, action: 'auth.staff.enrolled', entityType: 'User', entityId: user.id,
        before: { passwordHash: null, totpEnabledAt: null }, after: { passwordHash, totpEnabledAt: now },
      });
    });
    return { recoveryCodes: codes };
  }
}
