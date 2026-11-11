import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailService } from '../../src/platform/mail/mail.service';
import { tokenHash } from '../../src/platform/auth/tokens';
import { FLAGS } from '../../src/platform/flags/flag-registry';
import { STATE_HEADERS, TestApp, cookieFrom, createStaff, makeApp, requestMagicToken, sendAndExtract, signInCustomer, uniqueEmail } from '../support/auth';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

const ask = (email: string) => t.http().post('/auth/customer/magic-link').set(STATE_HEADERS).send({ email });
const verify = (token: string) => t.http().post('/auth/customer/magic-link/verify').set(STATE_HEADERS).send({ token });

describe('customer magic link', () => {
  it('magic_link_response_identical_for_unknown_email (and the same work is done)', async () => {
    const known = await signInCustomer(t);
    const unknown = uniqueEmail('customer');
    const a = await ask(known.email);
    const b = await ask(unknown);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body).toEqual(b.body);
    expect(Object.keys(a.headers).filter((h) => h !== 'x-request-id' && h !== 'date' && h !== 'etag').sort())
      .toEqual(Object.keys(b.headers).filter((h) => h !== 'x-request-id' && h !== 'date' && h !== 'etag').sort());
    for (const email of [known.email, unknown]) expect(await t.prisma.outboundEmail.count({ where: { to: email, templateKey: 'auth.magic_link', status: 'queued' } })).toBe(1);
  });

  it('magic_link_single_use_under_parallel_requests; signs in and creates the customer on first use', async () => {
    const email = uniqueEmail('customer');
    const token = await requestMagicToken(t, email);
    const results = await Promise.all([verify(token), verify(token), verify(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    const ok = results.find((r) => r.status === 200)!;
    expect(String(ok.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
    const cookie = `mt_customer_session=${cookieFrom(ok, 'mt_customer_session')}`;
    const me = await t.http().get('/auth/customer/session').set('Cookie', cookie);
    expect(me.body.email).toBe(email);
    expect(await t.prisma.user.count({ where: { kind: 'customer', email } })).toBe(1);
  });

  it('concurrent_first_sign_ins_create_one_customer', async () => {
    const email = uniqueEmail('customer');
    const first = await requestMagicToken(t, email);
    const second = await requestMagicToken(t, email);
    const results = await Promise.all([verify(first), verify(second)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await t.prisma.user.count({ where: { kind: 'customer', email } })).toBe(1);
  });

  it('magic_link_expired_rejected', async () => {
    const email = uniqueEmail('customer');
    const token = await requestMagicToken(t, email);
    await t.prisma.loginToken.updateMany({ where: { tokenHash: tokenHash(token) }, data: { expiresAt: new Date(Date.now() - 1) } });
    const r = await verify(token);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('link_invalid');
  });

  it('magic_link_get_does_not_consume_token: there is no GET, and inspect shows the address without consuming', async () => {
    const email = uniqueEmail('customer');
    const token = await requestMagicToken(t, email);
    expect((await t.http().get(`/auth/customer/magic-link/verify?token=${token}`)).status).toBe(404);
    const inspect = await t.http().post('/auth/customer/magic-link/inspect').set(STATE_HEADERS).send({ token });
    expect(inspect.body).toEqual({ email });
    expect((await verify(token)).status).toBe(200);
    expect((await t.http().post('/auth/customer/magic-link/inspect').set(STATE_HEADERS).send({ token })).status).toBe(400);
  });

  it('one_time_tokens_only_accepted_in_body', async () => {
    const email = uniqueEmail('customer');
    const token = await requestMagicToken(t, email);
    expect((await t.http().post(`/auth/customer/magic-link/verify?token=${token}`).set(STATE_HEADERS).send({})).status).toBe(422);
    expect((await t.http().post('/auth/customer/magic-link/verify').set(STATE_HEADERS).send({ token, extra: 1 })).status).toBe(422);
    expect((await verify(token)).status).toBe(200);
  });

  it('magic_link_retry_invalidates_previous_token and one_time_tokens_never_persisted_in_plaintext', async () => {
    const email = uniqueEmail('customer');
    const first = await requestMagicToken(t, email);
    // A retry of the same email (the first SMTP attempt "failed" after rendering): a new token, the old one dies.
    const row = await t.prisma.outboundEmail.findFirstOrThrow({ where: { to: email } });
    await t.prisma.outboundEmail.update({ where: { id: row.id }, data: { status: 'queued' } });
    await t.app.get(MailService).processSend(row.id);
    const second = /#token=([A-Za-z0-9_-]{43})/.exec(t.mail.sent.at(-1)!.text)![1]!;
    expect(second).not.toBe(first);
    expect((await verify(first)).status).toBe(400);
    for (const token of [first, second]) {
      const hits = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT (SELECT count(*) FROM login_tokens WHERE "tokenHash" = $1 OR email::text LIKE '%' || $1 || '%')
              + (SELECT count(*) FROM outbound_emails WHERE subject LIKE '%' || $1 || '%' OR "dedupeKey" LIKE '%' || $1 || '%')
              + (SELECT count(*) FROM pgboss.job WHERE data::text LIKE '%' || $1 || '%')
              + (SELECT count(*) FROM audit_logs WHERE changes::text LIKE '%' || $1 || '%')
              + (SELECT count(*) FROM audit_pii_values WHERE coalesce(after::text, '') LIKE '%' || $1 || '%') AS n`,
        token,
      );
      expect(Number(hits[0]!.n)).toBe(0);
    }
    expect((await verify(second)).status).toBe(200);
  });

  it('magic_link_request_audit_has_no_pii (G4)', async () => {
    const email = uniqueEmail('customer');
    await ask(email);
    const token = await t.prisma.loginToken.findFirstOrThrow({ where: { email }, orderBy: { createdAt: 'desc' } });
    const logs = await t.prisma.auditLog.findMany({ where: { entityType: 'LoginToken', entityId: token.id }, include: { piiValues: true } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe('auth.magicLink.requested');
    expect(logs[0]!.piiValues).toEqual([]);
    expect(JSON.stringify(logs[0]!.changes)).not.toContain(email);
  });

  it('first sign-in audits the new customer with the address as personal data of that customer', async () => {
    const c = await signInCustomer(t);
    const created = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: c.userId, action: 'auth.customer.created' }, include: { piiValues: true } });
    expect(created.changes).toMatchObject({ email: '[pii]', kind: { before: null, after: 'customer' } });
    expect(created.piiValues).toEqual([expect.objectContaining({ field: 'email', after: c.email, subjectUserId: c.userId })]);
  });

  it('more than three requests for one address in 15 minutes send nothing more, with the same answer', async () => {
    const email = uniqueEmail('customer');
    for (let i = 0; i < 5; i++) expect((await ask(email)).status).toBe(202);
    expect(await t.prisma.outboundEmail.count({ where: { to: email } })).toBe(3);
  });

  it('customer sign-in is behind its flag: off means 404', async () => {
    await t.prisma.featureFlag.update({ where: { key: FLAGS.customerSignIn }, data: { enabled: false } });
    try {
      expect((await ask(uniqueEmail('customer'))).status).toBe(404);
    } finally {
      await t.prisma.featureFlag.update({ where: { key: FLAGS.customerSignIn }, data: { enabled: true } });
    }
  });

  it('customer_session_rejected_by_admin_even_with_same_email', async () => {
    const staff = await createStaff(t, { owner: true });
    const customer = await signInCustomer(t, staff.email);
    const token = customer.cookie.split('=')[1];
    expect((await t.http().get('/admin/flags').set('Cookie', customer.cookie)).status).toBe(401);
    expect((await t.http().get('/admin/flags').set('Cookie', `mt_staff_session=${token}`)).status).toBe(401);
    expect((await t.http().get('/auth/staff/session').set('Cookie', `mt_staff_session=${token}`)).status).toBe(401);
    expect((await t.http().get('/auth/customer/session').set('Cookie', customer.cookie)).body.userId).toBe(customer.userId);
  });

  it('sign-out revokes the customer session', async () => {
    const c = await signInCustomer(t);
    expect((await t.http().post('/auth/customer/sign-out').set(STATE_HEADERS).set('Cookie', c.cookie)).status).toBe(200);
    expect((await t.http().get('/auth/customer/session').set('Cookie', c.cookie)).status).toBe(401);
  });

  it('a disabled customer cannot sign in', async () => {
    const c = await signInCustomer(t);
    await t.prisma.user.update({ where: { id: c.userId }, data: { status: 'disabled' } });
    expect((await t.http().get('/auth/customer/session').set('Cookie', c.cookie)).status).toBe(401);
    await ask(c.email);
    const token = await sendAndExtract(t, c.email);
    expect((await verify(token)).status).toBe(400);
  });
});
