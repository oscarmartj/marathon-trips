import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { OWNER_ROLE } from '../../src/platform/access/access.service';
import { hashPassword } from '../../src/platform/auth/passwords';
import { SECRET_BOX } from '../../src/platform/auth/staff-auth.service';
import { newRecoveryCode, recoveryCodeHash } from '../../src/platform/auth/tokens';
import { currentStep, newTotpSecret, totpCode } from '../../src/platform/auth/totp';
import type { AppConfig } from '../../src/platform/config/config';
import { SecretBox } from '../../src/platform/crypto/secret-box';
import { APP_CONFIG, PrismaService } from '../../src/platform/database/prisma.service';
import { FeatureFlagService } from '../../src/platform/flags/flags.service';
import { FLAGS } from '../../src/platform/flags/flag-registry';
import { configureApp } from '../../src/platform/http/configure-app';
import { MAIL_SENDER, MailMessage, MailSender } from '../../src/platform/mail/mail-sender';

export const WEB_ORIGIN = 'http://localhost:3000';
export const STATE_HEADERS = { Origin: WEB_ORIGIN, 'X-MT-CSRF': '1' };

/** Captures sent messages instead of talking SMTP. */
export class CapturingMailSender implements MailSender {
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage): Promise<{ providerMessageId: string }> {
    this.sent.push(m);
    return { providerMessageId: `test-${this.sent.length}` };
  }
}

/** The whole API, as main.ts builds it, with a capturing mail sender. Rate limit high unless a test asks otherwise. */
export async function makeApp(env: Record<string, string> = {}, opts: { allLogs?: boolean; controllers?: Array<new (...a: never[]) => object> } = {}) {
  const saved: Record<string, string | undefined> = {};
  const all = { AUTH_RATE_LIMIT_PER_MINUTE: '10000', BOOKING_REQUESTS_PER_HOUR_PER_USER: '10000', BOOKING_REQUESTS_PER_HOUR_PER_IP: '10000', PAYMENT_ATTEMPTS_PER_HOUR_PER_USER: '10000', PAYMENT_ATTEMPTS_PER_HOUR_PER_IP: '10000', PAYMENT_WEBHOOKS_PER_MINUTE_PER_IP: '100000', WEB_ORIGIN, ...env };
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const mail = new CapturingMailSender();
  try {
    const mod = await Test.createTestingModule({ imports: [AppModule], controllers: opts.controllers ?? [] }).overrideProvider(MAIL_SENDER).useValue(mail).compile();
    const app = mod.createNestApplication({ logger: opts.allLogs ? ['error', 'warn', 'log', 'debug', 'verbose'] : ['error'] });
    const config = app.get<AppConfig>(APP_CONFIG);
    configureApp(app, config);
    await app.init();
    const prisma = app.get(PrismaService);
    await app.get(FeatureFlagService).ensure(FLAGS.customerSignIn, true);
    await prisma.featureFlag.update({ where: { key: FLAGS.customerSignIn }, data: { enabled: true } });
    // Task 8.4: the integrations module is on, so route-walking tests reach its routes too (tests that need it off say so).
    await app.get(FeatureFlagService).ensure('module.integrations', true);
    await prisma.featureFlag.update({ where: { key: 'module.integrations' }, data: { enabled: true } });
    /** Closes the app and removes the jobs and events auth tests leave behind, so other test files start clean. */
    const close = async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'mail.send'`);
      await prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'auth.%' OR type LIKE 'access.%')`);
      await prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'auth.%' OR type LIKE 'access.%'`);
      await app.close();
    };
    return { app, prisma, mail, config, close, box: app.get<SecretBox>(SECRET_BOX), http: () => request(app.getHttpServer()) };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

let seq = 0;
export const uniqueEmail = (prefix = 'staff'): string => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`;

export interface StaffFixture {
  id: string;
  email: string;
  password: string;
  secret: string;
  recoveryCodes: string[];
}

/** A fully enrolled staff user, written straight to the database, with optional roles and an ad-hoc role of permissions. */
export async function createStaff(t: TestApp, opts: { owner?: boolean; permissions?: string[]; roleKeys?: string[]; enrolled?: boolean } = {}): Promise<StaffFixture> {
  const email = uniqueEmail();
  const password = `pw-${Math.random().toString(36).slice(2)}-long-enough`;
  const secret = newTotpSecret();
  const enrolled = opts.enrolled ?? true;
  const user = await t.prisma.user.create({ data: { kind: 'staff', email }, select: { id: true } });
  const enc = t.box.encrypt(secret, `totp:${user.id}`);
  await t.prisma.user.update({
    where: { id: user.id },
    data: enrolled ? { passwordHash: await hashPassword(password), totpSecretCiphertext: enc.ciphertext, totpKeyVersion: enc.keyVersion, totpEnabledAt: new Date() } : {},
  });
  const recoveryCodes = enrolled ? Array.from({ length: 3 }, () => newRecoveryCode()) : [];
  if (recoveryCodes.length) await t.prisma.recoveryCode.createMany({ data: recoveryCodes.map((c) => ({ userId: user.id, codeHash: recoveryCodeHash(t.config.AUTH_HMAC_KEY, c) })) });
  const roleKeys = [...(opts.roleKeys ?? [])];
  if (opts.owner) roleKeys.push(OWNER_ROLE);
  if (opts.permissions) {
    const key = `t${user.id.replace(/-/g, '').slice(-12)}`;
    const role = await t.prisma.role.create({ data: { key, name: `Test ${key}` } });
    if (opts.permissions.length) await t.prisma.rolePermission.createMany({ data: opts.permissions.map((p) => ({ roleId: role.id, permissionKey: p })) });
    roleKeys.push(key);
  }
  for (const k of roleKeys) {
    const role = await t.prisma.role.findUniqueOrThrow({ where: { key: k } });
    await t.prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  return { id: user.id, email, password, secret, recoveryCodes };
}

/** A TOTP code that has not been used yet for this user (tests may sign in several times within 30 seconds). */
export async function freshCode(t: TestApp, s: StaffFixture): Promise<string> {
  await t.prisma.user.update({ where: { id: s.id }, data: { totpLastUsedStep: BigInt(currentStep() - 2) } });
  return totpCode(s.secret);
}

export async function clearDelay(t: TestApp, userId: string): Promise<void> {
  await t.prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, nextLoginAllowedAt: null } });
}

export const cookieFrom = (res: { headers: Record<string, unknown> }, name: string): string | undefined => {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const hit = list.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0]!.slice(name.length + 1) : undefined;
};

/** Password, then TOTP. Returns the staff session cookie header value. */
export async function signInStaff(t: TestApp, s: StaffFixture): Promise<string> {
  const step1 = await t.http().post('/auth/staff/sign-in').set(STATE_HEADERS).send({ email: s.email, password: s.password });
  if (step1.status !== 200) throw new Error(`password step failed: ${step1.status} ${JSON.stringify(step1.body)}`);
  const mfa = cookieFrom(step1, 'mt_staff_mfa');
  const step2 = await t.http().post('/auth/staff/sign-in/second-factor').set(STATE_HEADERS).set('Cookie', `mt_staff_mfa=${mfa}`).send({ code: await freshCode(t, s) });
  if (step2.status !== 200) throw new Error(`second factor failed: ${step2.status} ${JSON.stringify(step2.body)}`);
  return `mt_staff_session=${cookieFrom(step2, 'mt_staff_session')}`;
}

/** Signs a customer in through the real magic-link flow and returns the cookie header and the user id. */
export async function signInCustomer(t: TestApp, email = uniqueEmail('customer')): Promise<{ cookie: string; userId: string; email: string }> {
  const token = await requestMagicToken(t, email);
  const res = await t.http().post('/auth/customer/magic-link/verify').set(STATE_HEADERS).send({ token });
  if (res.status !== 200) throw new Error(`verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await t.prisma.user.findUniqueOrThrow({ where: { kind_email: { kind: 'customer', email } } });
  return { cookie: `mt_customer_session=${cookieFrom(res, 'mt_customer_session')}`, userId: user.id, email };
}

/** Requests a link and runs the send step; returns the token from the captured email. */
export async function requestMagicToken(t: TestApp, email: string): Promise<string> {
  const res = await t.http().post('/auth/customer/magic-link').set(STATE_HEADERS).send({ email });
  if (res.status !== 202) throw new Error(`request failed: ${res.status}`);
  return sendAndExtract(t, email);
}

export async function sendAndExtract(t: TestApp, email: string): Promise<string> {
  const { MailService } = await import('../../src/platform/mail/mail.service');
  const queued = await t.prisma.outboundEmail.findFirstOrThrow({ where: { to: email, status: 'queued' }, orderBy: { createdAt: 'desc' } });
  await t.app.get(MailService).processSend(queued.id);
  const msg = [...t.mail.sent].reverse().find((m) => m.to === email);
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(msg?.text ?? '')?.[1];
  if (!token) throw new Error('no token in the email');
  return token;
}

