import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brand } from '@mt/shared';
import { guessablePassword } from '../../src/platform/auth/passwords';
import { StaffAuthService } from '../../src/platform/auth/staff-auth.service';
import { totpCode } from '../../src/platform/auth/totp';
import { STATE_HEADERS, TestApp, cookieFrom, createStaff, freshCode, makeApp, signInStaff, uniqueEmail } from '../support/auth';

// Task 8.5: common passwords (ASVS 5.0 6.2.4) and a new session token on re-authentication (7.2.4).
let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

const ctx = { email: 'jane.citizen@example.test', brandName: brand.name };

describe('guessable passwords (S-01)', () => {
  it.each([
    'qwerty123456', 'QWERTY123456', '1q2w3e4r5t6y', 'iloveyou1234', 'aaaaaaaaaaaa', 'abcdefghijklmnop', '123456789012', '987654321098',
    'MarathonTrips!', 'marathon-trips-2026', 'jane.citizen99', 'JaneCitizen!!',
  ])('refuses %s', (p) => expect(guessablePassword(p, ctx)).toBe(true));

  it.each(['correct horse battery staple', 'a-long-enough-password', 'Kangaroo paddock at dawn', 'zq8-tram-velvet-ochre'])('accepts %s', (p) => {
    expect(guessablePassword(p, ctx)).toBe(false);
  });

  async function newEnrolment() {
    const user = await t.prisma.user.create({ data: { kind: 'staff', email: uniqueEmail() } });
    const svc = t.app.get(StaffAuthService);
    const link = await t.prisma.$transaction((tx) => svc.issueEnrolment(tx, user.id, user.email));
    return { user, token: /#token=(.+)$/.exec(link.url)![1]! };
  }

  it('enrolment refuses a common password with 422 password_too_common, keeps the link and spends no attempt', async () => {
    const { user, token } = await newEnrolment();
    const start = await t.http().post('/auth/staff/enrolment/start').set(STATE_HEADERS).send({ token });
    for (let i = 0; i < 6; i++) {
      const weak = await t.http().post('/auth/staff/enrolment/complete').set(STATE_HEADERS).send({ token, password: 'qwerty123456', code: totpCode(start.body.secret) });
      expect(weak.status).toBe(422);
      expect(weak.body.code).toBe('password_too_common');
    }
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.totpEnabledAt).toBeNull();
    const ok = await t.http().post('/auth/staff/enrolment/complete').set(STATE_HEADERS).send({ token, password: 'zq8-tram-velvet-ochre', code: totpCode(start.body.secret) });
    expect(ok.status).toBe(200);
  });
});

describe('step-up renews the session token (S-02)', () => {
  it('a good step-up sets a new cookie; the old token stops working; the session row, its id and its expiry stay', async () => {
    const s = await createStaff(t);
    const cookie = await signInStaff(t, s);
    const before = await t.prisma.session.findFirstOrThrow({ where: { userId: s.id, revokedAt: null } });
    const up = await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', cookie).send({ code: await freshCode(t, s) });
    expect(up.status).toBe(200);
    const fresh = cookieFrom(up, 'mt_staff_session');
    expect(fresh).toBeTruthy();
    expect(`mt_staff_session=${fresh}`).not.toBe(cookie);
    const setCookie = ([] as string[]).concat(up.headers['set-cookie'] ?? []).find((c) => c.startsWith('mt_staff_session='))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)![1]);
    expect(maxAge).toBeLessThanOrEqual(Math.ceil((before.expiresAt.getTime() - Date.now()) / 1000));

    expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(401);
    const now = await t.http().get('/auth/staff/session').set('Cookie', `mt_staff_session=${fresh}`);
    expect(now.status).toBe(200);
    expect(now.body.stepUpValidUntil).not.toBeNull();
    const after = await t.prisma.session.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(after.tokenHash).not.toBe(before.tokenHash);
    expect(after.revokedAt).toBeNull();
  });

  it('a wrong step-up code renews nothing: the same cookie keeps working and no session cookie is set', async () => {
    const s = await createStaff(t);
    const cookie = await signInStaff(t, s);
    const bad = await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', cookie).send({ code: '000000' });
    expect(bad.status).toBe(401);
    expect(cookieFrom(bad, 'mt_staff_session')).toBeUndefined();
    expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(200);
  });

  it('a session revoked while the code is checked is not renewed', async () => {
    const s = await createStaff(t);
    const cookie = await signInStaff(t, s);
    const row = await t.prisma.session.findFirstOrThrow({ where: { userId: s.id, revokedAt: null } });
    const svc = t.app.get(StaffAuthService);
    const code = await freshCode(t, s);
    await t.prisma.session.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokeReason: 'sign_out' } });
    await expect(svc.stepUp(s.id, row.id, code)).rejects.toMatchObject({ code: 'session_not_live' });
    expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(401);
  });
});
