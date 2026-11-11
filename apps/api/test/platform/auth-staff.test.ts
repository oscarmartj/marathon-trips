import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delaySeconds } from '../../src/platform/auth/attempt-limiter';
import { StaffAuthService } from '../../src/platform/auth/staff-auth.service';
import { tokenHash } from '../../src/platform/auth/tokens';
import { totpCode, verifyTotp } from '../../src/platform/auth/totp';
import { SYSTEM_ACTOR } from '../../src/platform/audit/audit.service';
import {
  STATE_HEADERS, StaffFixture, TestApp, clearDelay, cookieFrom, createStaff, freshCode, makeApp, signInStaff, uniqueEmail,
} from '../support/auth';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

const passwordStep = (s: { email: string; password: string }) => t.http().post('/auth/staff/sign-in').set(STATE_HEADERS).send({ email: s.email, password: s.password });
const secondFactor = (mfa: string | undefined, body: object) => t.http().post('/auth/staff/sign-in/second-factor').set(STATE_HEADERS).set('Cookie', `mt_staff_mfa=${mfa ?? ''}`).send(body);
async function mfaCookie(s: StaffFixture): Promise<string> {
  const r = await passwordStep(s);
  expect(r.status).toBe(200);
  return cookieFrom(r, 'mt_staff_mfa')!;
}
const sessionsOf = (userId: string) => t.prisma.session.count({ where: { userId, revokedAt: null } });

describe('TOTP primitives', () => {
  it('totp_rfc6238_vectors (SHA-1, last 6 digits)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
    for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']] as const) {
      expect(totpCode(secret, seconds * 1000)).toBe(code);
      expect(verifyTotp(secret, code, seconds * 1000)).toBe(Math.floor(seconds / 30));
    }
    expect(verifyTotp(secret, '287082', 59_000 + 90_000)).toBeNull(); // outside the ±1 step window
    expect(verifyTotp(secret, 'abcdef', 59_000)).toBeNull();
  });

  it('delay schedule: none for two failures, then 1 s doubling to 15 minutes', () => {
    expect([1, 2, 3, 4, 5, 12, 13, 50].map(delaySeconds)).toEqual([0, 0, 1, 2, 4, 512, 900, 900]);
  });
});

describe('staff sign-in', () => {
  it('password then TOTP creates a session; the password alone never does', async () => {
    const s = await createStaff(t);
    const mfa = await mfaCookie(s);
    expect(await sessionsOf(s.id)).toBe(0);
    const res = await secondFactor(mfa, { code: await freshCode(t, s) });
    expect(res.status).toBe(200);
    expect(cookieFrom(res, 'mt_staff_session')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(await sessionsOf(s.id)).toBe(1);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: s.id } });
    expect(user.failedLoginCount).toBe(0);
  });

  it('staff_sign_in_unknown_email_indistinguishable and staff_without_password_indistinguishable', async () => {
    const enrolled = await createStaff(t);
    const notEnrolled = await createStaff(t, { enrolled: false });
    const wrong = await passwordStep({ email: enrolled.email, password: 'definitely-wrong-password' });
    const unknown = await passwordStep({ email: uniqueEmail('nobody'), password: 'definitely-wrong-password' });
    const noPassword = await passwordStep({ email: notEnrolled.email, password: 'definitely-wrong-password' });
    for (const r of [wrong, unknown, noPassword]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ code: 'invalid_credentials', message: 'The email or password is not right' });
      expect(cookieFrom(r, 'mt_staff_mfa')).toBeUndefined();
    }
    // Same delay schedule for a known and an unknown address: the fourth try inside the delay is a 429 for both.
    const ghost = uniqueEmail('nobody');
    for (const target of [{ email: enrolled.email }, { email: ghost }]) {
      await clearDelay(t, enrolled.id);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await passwordStep({ ...target, password: 'definitely-wrong-password' })).status);
      expect(statuses).toEqual([401, 401, 401, 429]);
    }
  });

  it('progressive_delay_without_permanent_lockout', async () => {
    const s = await createStaff(t);
    for (let i = 0; i < 3; i++) expect((await passwordStep({ ...s, password: 'wrong-password-123' })).status).toBe(401);
    const blocked = await passwordStep(s);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Checked before argon2: a blocked attempt is not counted and not verified, even with the right password.
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: s.id } })).failedLoginCount).toBe(3);
    // Once the delay has passed the right password works again: no permanent lock-out.
    await t.prisma.user.update({ where: { id: s.id }, data: { nextLoginAllowedAt: new Date(Date.now() - 1000) } });
    const cookie = await signInStaff(t, s);
    expect(cookie).toMatch(/^mt_staff_session=/);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: s.id } })).failedLoginCount).toBe(0);
  });

  it('totp_failures_feed_account_delay (G2)', async () => {
    const s = await createStaff(t);
    const mfa = await mfaCookie(s);
    expect((await secondFactor(mfa, { code: '000000' })).status).toBe(401);
    expect((await secondFactor(mfa, { code: '000001' })).status).toBe(401);
    expect((await secondFactor(mfa, { code: '000002' })).status).toBe(401);
    const blocked = await secondFactor(mfa, { code: await freshCode(t, s) });
    expect(blocked.status).toBe(429);
    const u = await t.prisma.user.findUniqueOrThrow({ where: { id: s.id } });
    expect(u.failedLoginCount).toBeGreaterThanOrEqual(3);
    expect(u.nextLoginAllowedAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('mfa_step_invalidated_after_five_wrong_codes', async () => {
    const s = await createStaff(t);
    const mfa = await mfaCookie(s);
    for (let i = 0; i < 5; i++) {
      await clearDelay(t, s.id);
      expect((await secondFactor(mfa, { code: `00000${i}` })).body.code).toBe('invalid_code');
    }
    await clearDelay(t, s.id);
    const res = await secondFactor(mfa, { code: await freshCode(t, s) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_expired');
    expect(await sessionsOf(s.id)).toBe(0);
  });

  it('mfa_attempts_limited_under_parallel_requests', async () => {
    const s = await createStaff(t);
    const mfa = await mfaCookie(s);
    await clearDelay(t, s.id);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => secondFactor(mfa, { code: String(100000 + i) })));
    expect(results.every((r) => [401, 429].includes(r.status))).toBe(true);
    const token = await t.prisma.loginToken.findUniqueOrThrow({ where: { tokenHash: tokenHash(mfa) } });
    expect(token.attempts).toBeLessThanOrEqual(5);
    // Every attempt that was checked was counted on the account before the check.
    const u = await t.prisma.user.findUniqueOrThrow({ where: { id: s.id } });
    expect(u.failedLoginCount).toBeGreaterThanOrEqual(token.attempts);
    expect(await sessionsOf(s.id)).toBe(0);
  });

  it('totp_code_cannot_be_reused, also by two parallel second-factor steps', async () => {
    const s = await createStaff(t);
    const [a, b] = [await mfaCookie(s), await mfaCookie(s)];
    await clearDelay(t, s.id);
    const code = await freshCode(t, s);
    const results = await Promise.all([secondFactor(a, { code }), secondFactor(b, { code })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await sessionsOf(s.id)).toBe(1);
    await clearDelay(t, s.id);
    const again = await secondFactor(await mfaCookie(s), { code });
    expect(again.body.code).toBe('invalid_code');
  });

  it('recovery_code_single_use_under_parallel_requests', async () => {
    const s = await createStaff(t);
    const [a, b] = [await mfaCookie(s), await mfaCookie(s)];
    await clearDelay(t, s.id);
    const recoveryCode = s.recoveryCodes[0]!.toLowerCase(); // typed in lower case still works
    const results = await Promise.all([secondFactor(a, { recoveryCode }), secondFactor(b, { recoveryCode })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await t.prisma.recoveryCode.count({ where: { userId: s.id, usedAt: { not: null } } })).toBe(1);
  });

  it('recovery_code_sign_in_does_not_open_step_up: a sensitive action right after still asks for a TOTP code', async () => {
    const s = await createStaff(t, { owner: true });
    const target = await createStaff(t, { permissions: [] });
    const res = await secondFactor(await mfaCookie(s), { recoveryCode: s.recoveryCodes[1] });
    expect(res.status).toBe(200);
    const cookie = `mt_staff_session=${cookieFrom(res, 'mt_staff_session')}`;
    const session = await t.prisma.session.findFirstOrThrow({ where: { userId: s.id, revokedAt: null } });
    expect(session.mfaVerifiedAt).toBeNull();
    const reset = await t.http().post(`/admin/staff/${target.id}/reset-enrolment`).set(STATE_HEADERS).set('Cookie', cookie).send({});
    expect(reset.status).toBe(403);
    expect(reset.body.code).toBe('step_up_required');
    expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).body.stepUpValidUntil).toBeNull();
  });

  it('failure_count_window_symmetric: known and unknown addresses start again after an hour without attempts', async () => {
    const s = await createStaff(t);
    // A known account with old failures behaves like an unknown address whose memory entry expired: two free tries.
    await t.prisma.user.update({ where: { id: s.id }, data: { failedLoginCount: 9, lastFailedLoginAt: new Date(Date.now() - 3601_000), nextLoginAllowedAt: null } });
    const ghost = uniqueEmail('nobody');
    for (const email of [s.email, ghost]) {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await passwordStep({ email, password: 'definitely-wrong-password' })).status);
      expect(statuses, email).toEqual([401, 401, 401, 429]);
    }
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: s.id } })).failedLoginCount).toBe(3);
    const { UnknownAccountDelay } = await import('../../src/platform/auth/attempt-limiter');
    const d = new UnknownAccountDelay();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) d.claim('k', t0 + i);
    expect(() => d.claim('k', t0 + 10)).toThrow();
    // an hour after the last attempt the count starts again
    expect(() => d.claim('k', t0 + 2 + 3600_000)).not.toThrow();
    expect(() => d.claim('k', t0 + 3 + 3600_000)).not.toThrow();
  });

  it('disabled_during_mfa_step_gets_no_session (G2)', async () => {
    const s = await createStaff(t);
    const mfa = await mfaCookie(s);
    await t.prisma.user.update({ where: { id: s.id }, data: { status: 'disabled' } });
    const res = await secondFactor(mfa, { code: await freshCode(t, s) });
    expect(res.status).toBe(401);
    expect(await t.prisma.session.count({ where: { userId: s.id } })).toBe(0);
  });

  it('session_expires_absolute_and_idle, and a revoked or disabled session is refused', async () => {
    const s = await createStaff(t, { permissions: [] });
    const session = await t.http().get('/auth/staff/session');
    expect(session.status).toBe(401);
    for (const change of [{ expiresAt: new Date(Date.now() - 1) }, { idleExpiresAt: new Date(Date.now() - 1) }, { revokedAt: new Date() }]) {
      const cookie = await signInStaff(t, s);
      expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(200);
      await t.prisma.session.updateMany({ where: { userId: s.id, revokedAt: null }, data: change });
      expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(401);
      await t.prisma.session.updateMany({ where: { userId: s.id }, data: { revokedAt: new Date() } });
    }
  });

  it('sign-out revokes the session', async () => {
    const s = await createStaff(t);
    const cookie = await signInStaff(t, s);
    expect((await t.http().post('/auth/staff/sign-out').set(STATE_HEADERS).set('Cookie', cookie)).status).toBe(200);
    expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('step-up (G3)', () => {
  it('step_up_totp_cannot_be_reused: the code used to sign in does not also step up', async () => {
    const s = await createStaff(t);
    const mfa = await mfaCookie(s);
    const code = await freshCode(t, s);
    const signed = await secondFactor(mfa, { code });
    const cookie = `mt_staff_session=${cookieFrom(signed, 'mt_staff_session')}`;
    const res = await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', cookie).send({ code });
    expect(res.body.code).toBe('invalid_code');
    const ok = await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', cookie).send({ code: await freshCode(t, s) });
    expect(ok.status).toBe(200);
  });

  it('recovery codes are not accepted for step-up', async () => {
    const s = await createStaff(t);
    const cookie = await signInStaff(t, s);
    const res = await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', cookie).send({ recoveryCode: s.recoveryCodes[0] });
    expect(res.status).toBe(422);
  });

  it('step_up_wrong_codes_revoke_session (and feed the account delay)', async () => {
    const s = await createStaff(t);
    const cookie = await signInStaff(t, s);
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      await clearDelay(t, s.id);
      const r = await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', cookie).send({ code: `12345${i}` });
      codes.push(r.body.code);
    }
    expect(codes).toEqual(['invalid_code', 'invalid_code', 'invalid_code', 'invalid_code', 'session_revoked']);
    expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(401);
    const blocked = await createStaff(t);
    const c2 = await signInStaff(t, blocked);
    for (let i = 0; i < 3; i++) await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', c2).send({ code: `00000${i}` });
    expect((await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', c2).send({ code: '000009' })).status).toBe(429);
  });
});

describe('enrolment (M3)', () => {
  async function newEnrolment() {
    const user = await t.prisma.user.create({ data: { kind: 'staff', email: uniqueEmail() } });
    const svc = t.app.get(StaffAuthService);
    const link = await t.prisma.$transaction((tx) => svc.issueEnrolment(tx, user.id, user.email));
    return { user, token: /#token=(.+)$/.exec(link.url)![1]!, url: link.url };
  }

  it('enrolment_link_single_use_and_expires; returns recovery codes once and no session', async () => {
    const { user, token, url } = await newEnrolment();
    expect(url).toMatch(/^http:\/\/localhost:3000\/admin\/enrol#token=/);
    const start = await t.http().post('/auth/staff/enrolment/start').set(STATE_HEADERS).send({ token });
    expect(start.status).toBe(200);
    expect(start.body.email).toBe(user.email);
    const code = totpCode(start.body.secret);
    const done = await t.http().post('/auth/staff/enrolment/complete').set(STATE_HEADERS).send({ token, password: 'a-long-enough-password', code });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    expect(cookieFrom(done, 'mt_staff_session')).toBeUndefined();
    const again = await t.http().post('/auth/staff/enrolment/start').set(STATE_HEADERS).send({ token });
    expect(again.body.code).toBe('enrolment_link_invalid');
    // The secret is stored encrypted, never in clear.
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.totpSecretCiphertext).not.toContain(start.body.secret);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);

    const expired = await newEnrolment();
    await t.prisma.loginToken.updateMany({ where: { userId: expired.user.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await t.http().post('/auth/staff/enrolment/start').set(STATE_HEADERS).send({ token: expired.token })).body.code).toBe('enrolment_link_invalid');
  });

  it('totp_secret_encrypted_at_rest and five wrong confirmation codes kill the link; a new link kills the old one', async () => {
    const { user, token } = await newEnrolment();
    const start = await t.http().post('/auth/staff/enrolment/start').set(STATE_HEADERS).send({ token });
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.totpSecretCiphertext).toBeTruthy();
    expect(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(start.body.secret);
    for (let i = 0; i < 5; i++) {
      const r = await t.http().post('/auth/staff/enrolment/complete').set(STATE_HEADERS).send({ token, password: 'a-long-enough-password', code: `00000${i}` });
      expect(r.status).toBe(422);
    }
    const last = await t.http().post('/auth/staff/enrolment/complete').set(STATE_HEADERS).send({ token, password: 'a-long-enough-password', code: totpCode(start.body.secret) });
    expect(last.body.code).toBe('enrolment_link_invalid');

    const second = await newEnrolment();
    const svc = t.app.get(StaffAuthService);
    await t.prisma.$transaction((tx) => svc.resetCredentials(tx, second.user.id, SYSTEM_ACTOR));
    expect((await t.http().post('/auth/staff/enrolment/start').set(STATE_HEADERS).send({ token: second.token })).body.code).toBe('enrolment_link_invalid');
  });

  it('reset revokes sessions and pending sign-in steps', async () => {
    const s = await createStaff(t);
    const cookie = await signInStaff(t, s);
    const pending = await mfaCookie(s);
    const svc = t.app.get(StaffAuthService);
    await t.prisma.$transaction((tx) => svc.resetCredentials(tx, s.id, SYSTEM_ACTOR));
    expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(401);
    await clearDelay(t, s.id);
    expect((await secondFactor(pending, { code: totpCode(s.secret) })).body.code).toBe('mfa_expired');
    expect((await passwordStep(s)).status).toBe(401);
  });
});
