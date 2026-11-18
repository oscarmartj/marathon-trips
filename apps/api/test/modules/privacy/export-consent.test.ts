// The data export, marketing consent and one-click unsubscribe (task 5.5, plan docs/plans/5.5-privacy-export-erase.md,
// sections 2.4-2.7, 6, 7 and 10.9-10.10).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MARKETING_WORDING_KEY } from '@mt/shared';
import { ConsentService } from '../../../src/modules/privacy';
import { emailHash, unsubscribeToken } from '../../../src/platform/crypto/hmac';
import { MailService } from '../../../src/platform/mail/mail.service';
import { STATE_HEADERS, TestApp, makeApp, signInCustomer, uniqueEmail } from '../../support/auth';
import { cleanBookingEvents, contact, requestBody } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import { approvedBooking, cleanPayments, ensureTerms, onlyAccount, paymentsStaff, simulatorAccount } from '../../support/payments';
import { privacyStaff, stepUpOld } from '../../support/privacy';
import type { StaffHttp } from '../../support/privacy';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let owner: StaffHttp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let w: PricedWorld;
beforeAll(async () => {
  t = await makeApp();
  owner = await privacyStaff(t, { owner: true });
  admin = await paymentsStaff(t);
  await onlyAccount(t, (await simulatorAccount(t)).id);
  await ensureTerms(t);
  w = await pricedWorld(admin);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

type Who = { cookie: string; userId: string; email: string };
const as = (who: Who) => ({
  get: (path: string) => t.http().get(path).set('Cookie', who.cookie),
  post: (path: string, body: object = {}) => t.http().post(path).set(STATE_HEADERS).set('Cookie', who.cookie).send(body),
  put: (path: string, body: object) => t.http().put(path).set(STATE_HEADERS).set('Cookie', who.cookie).send(body),
});

/** A signed-in customer with a booking request (so a customer record), its names carrying `marker`. */
async function bookedCustomer(marker: string): Promise<Who & { customerId: string; reference: string; bookingId: string }> {
  const who = await signInCustomer(t, uniqueEmail(marker.toLowerCase()));
  const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', who.cookie).set('Idempotency-Key', randomUUID())
    .send(requestBody(w, { contact: contact({ givenName: `${marker}given`, familyName: `${marker}family` }) }));
  expect(res.status).toBe(201);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string }, select: { id: true, customerId: true, reference: true } });
  return { ...who, customerId: b.customerId, reference: b.reference, bookingId: b.id };
}

const download = (who: Who) => as(who).get('/account/privacy/export').buffer(true).parse((res, cb) => {
  let s = '';
  res.on('data', (x: Buffer) => (s += x.toString('utf8')));
  res.on('end', () => cb(null, s));
});
const parsed = (body: unknown) => JSON.parse(body as string) as Record<string, unknown>;

describe('the customer download', () => {
  it('anonymous 401; staff cannot use it; the route takes no id', async () => {
    expect((await t.http().get('/account/privacy/export')).status).toBe(401);
    expect((await owner.get('/account/privacy/export')).status).toBe(401);
  });

  it('only my data, no staff notes, no ids, hashes or tokens; JSON attachment that no cache keeps; nothing stored but the request', async () => {
    const me = await bookedCustomer('Mine');
    const other = await bookedCustomer('Theirs');
    const complaint = await t.prisma.complaint.create({ data: { reference: 'CP-ABCDEF'.replace('ABCDEF', randomUUID().replace(/[^0-9]/g, '').slice(0, 6).replace(/./g, (d) => 'ABCDEFGHJK'[Number(d)]!)), customerId: me.customerId, complainantName: 'Mine Complainant', channel: 'email', category: 'service', summary: 'Mine summary', description: 'Mine words', receivedDate: new Date(), acknowledgeDueDate: new Date(), resolveDueDate: new Date(), createdById: owner.staff.id } });
    for (const [entityType, entityId] of [['Customer', me.customerId], ['Booking', me.bookingId], ['Complaint', complaint.id]] as const) {
      await t.prisma.note.create({ data: { entityType, entityId, body: `STAFFNOTE about ${entityType}`, authorId: owner.staff.id } });
    }
    const jobsBefore = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pgboss.job`);
    const filesBefore = await t.prisma.storedFile.count();
    const res = await download(me);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="marathon-trips-data-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = res.body as string;
    const data = parsed(text);
    expect(data.format).toBe('marathon-trips.personal-data.v1');
    expect(text).toContain('Minegiven');
    expect(text).toContain(me.reference);
    expect(text).toContain('Mine words');
    expect(text).not.toContain('STAFFNOTE');
    expect(text).not.toContain('Theirsgiven');
    expect(text).not.toContain(other.reference);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // no ids at all
    expect(text).not.toMatch(/"[^"]*(Id|id|Hash|hash|token|Token|secret)":/);
    expect((data.sections as Record<string, unknown>).Booking).toBeTruthy();
    expect((await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pgboss.job`))[0]!.n).toBe(jobsBefore[0]!.n);
    expect(await t.prisma.storedFile.count()).toBe(filesBefore);
    const req = await t.prisma.privacyRequest.findFirstOrThrow({ where: { customerId: me.customerId, kind: 'export' } });
    expect(req).toMatchObject({ status: 'completed', requestedBy: 'customer' });
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'privacy.export.generated', entityId: me.customerId }, include: { piiValues: true } });
    expect(log.piiValues).toEqual([]);

    // The owner: subject by default (no staff notes); full adds them for a formal access request.
    const sub = await owner.get(`/admin/privacy/customers/${me.customerId}/export`);
    expect(sub.status).toBe(200);
    expect(sub.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(sub.body)).not.toContain('STAFFNOTE');
    const full = await owner.get(`/admin/privacy/customers/${me.customerId}/export?audience=full`);
    const notes = (full.body.staffNotes as Array<{ text: string }>).map((n) => n.text).sort();
    expect(notes).toEqual(['STAFFNOTE about Booking', 'STAFFNOTE about Complaint', 'STAFFNOTE about Customer']);
    await stepUpOld(t, owner.staff.id);
    expect((await owner.get(`/admin/privacy/customers/${me.customerId}/export`)).status).toBe(403);
    owner = await privacyStaff(t, { owner: true });
  });

  it('rate limited: the sixth download in an hour is 429', async () => {
    const me = await signInCustomer(t, uniqueEmail('limit'));
    for (let i = 0; i < 5; i++) expect((await download(me)).status).toBe(200);
    const r = await download(me);
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeTruthy();
  });

  it('an account with no customer record exports its account data and the alerts of its address', async () => {
    const me = await signInCustomer(t, uniqueEmail('nocust'));
    await t.prisma.race.update({ where: { id: w.race.id }, data: { status: 'published' } });
    expect((await t.http().post('/alerts/subscriptions').set(STATE_HEADERS).send({ email: me.email.toUpperCase(), raceSlug: w.race.slug })).status).toBe(202);
    const data = parsed((await download(me)).body);
    expect(data.account).toMatchObject({ email: me.email });
    expect((data.sections as Record<string, unknown[]>).AlertSubscription).toHaveLength(1);
  });
});

describe('marketing consent', () => {
  const consent = (who: Who, granted: boolean, wordingKey = MARKETING_WORDING_KEY) => as(who).put('/account/privacy/marketing-consent', { granted, wordingKey });

  it('none by default; accepting the booking terms records no consent; an outdated wording is 422', async () => {
    const me = await bookedCustomer('Terms');
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: me.bookingId } });
    await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version });
    const { acceptCurrentTerms } = await import('../../support/payments');
    await acceptCurrentTerms(t, me, me.reference);
    expect(await t.prisma.termsAcceptance.count({ where: { customerId: me.customerId } })).toBe(1);
    expect(await t.prisma.consentRecord.count({ where: { customerId: me.customerId } })).toBe(0);
    const view = await as(me).get('/account/privacy');
    expect(view.body).toMatchObject({ hasCustomerRecord: true, marketingConsent: { granted: false, recordedAt: null }, wordingKey: MARKETING_WORDING_KEY, erasureRequest: null });
    expect((await consent(me, true, 'marketing_email.v0')).status).toBe(422);
    void approvedBooking;
  });

  it('grant and withdraw are recorded once each; withdrawal suppresses marketing only and keeps an `all` suppression; grant lifts only an unsubscribe', async () => {
    const me = await bookedCustomer('Cons');
    expect((await consent(me, true)).status).toBe(200);
    expect((await consent(me, true)).status).toBe(200);
    expect(await t.prisma.consentRecord.count({ where: { customerId: me.customerId } })).toBe(1);
    expect((await as(me).get('/account/privacy')).body.marketingConsent.granted).toBe(true);
    expect((await consent(me, false)).status).toBe(200);
    expect((await consent(me, false)).status).toBe(200);
    const rows = await t.prisma.consentRecord.findMany({ where: { customerId: me.customerId }, orderBy: { recordedAt: 'asc' } });
    expect(rows.map((r) => [r.granted, r.source, r.wordingKey])).toEqual([[true, 'account', MARKETING_WORDING_KEY], [false, 'account', MARKETING_WORDING_KEY]]);
    const hash = emailHash(t.config.EMAIL_HASH_KEY, me.email);
    expect(await t.prisma.emailSuppression.findUnique({ where: { emailHash: hash } })).toMatchObject({ reason: 'unsubscribed', scope: 'marketing' });
    // Marketing mail to the address is suppressed at send; transactional is not.
    const mail = t.app.get(MailService);
    const m = await t.prisma.$transaction((tx) => mail.enqueue({ to: me.email, templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', dedupeKey: `c:${randomUUID()}`, category: 'marketing' }, tx));
    expect(await mail.processSend(m.id)).toBe('suppressed');
    expect((await consent(me, true)).status).toBe(200);
    expect(await t.prisma.emailSuppression.findUnique({ where: { emailHash: hash } })).toBeNull();
    // A bounce is never downgraded or lifted.
    await mail.addSuppression(me.email, 'bounced', 'all');
    await mail.addSuppression(me.email, 'unsubscribed', 'marketing');
    expect(await t.prisma.emailSuppression.findUnique({ where: { emailHash: hash } })).toMatchObject({ reason: 'bounced', scope: 'all' });
    expect((await consent(me, false)).status).toBe(200);
    expect((await consent(me, true)).status).toBe(200);
    expect(await t.prisma.emailSuppression.findUnique({ where: { emailHash: hash } })).toMatchObject({ reason: 'bounced', scope: 'all' });
  });

  it('an account with no customer record keeps consent by address, and it carries over to the customer created later', async () => {
    const me = await signInCustomer(t, uniqueEmail('later'));
    expect((await as(me).get('/account/privacy')).body.hasCustomerRecord).toBe(false);
    expect((await consent(me, true)).status).toBe(200);
    const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', me.cookie).set('Idempotency-Key', randomUUID()).send(requestBody(w));
    expect(res.status).toBe(201);
    const view = (await as(me).get('/account/privacy')).body;
    expect(view).toMatchObject({ hasCustomerRecord: true, marketingConsent: { granted: true } });
  });

  it('the account page and an unsubscribe link racing on one address are serialised by the advisory lock (barrier)', async () => {
    // An account with no customer record: neither side takes a customer lock, so only the address lock orders them.
    const me = await signInCustomer(t, uniqueEmail('race'));
    const mail = t.app.get(MailService);
    const m = await t.prisma.$transaction((tx) => mail.enqueue({ to: me.email, templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', dedupeKey: `r:${randomUUID()}`, category: 'marketing' }, tx));
    const ref = `${m.id}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, m.id)}`;
    const svc = t.app.get(ConsentService);
    const current = svc.current.bind(svc);
    let calls = 0;
    let inside!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (inside = r));
    const gate = new Promise<void>((r) => (release = r));
    // current() runs after the address lock is taken: the first caller holds the lock at the barrier.
    const spy = vi.spyOn(svc, 'current').mockImplementation(async (...a: Parameters<typeof current>) => {
      if (++calls === 1) {
        inside();
        await gate;
      }
      return current(...a);
    });
    try {
      const granting = as(me).put('/account/privacy/marketing-consent', { granted: true, wordingKey: MARKETING_WORDING_KEY }).then((r) => r);
      await entered;
      const unsubscribing = t.http().post(`/unsubscribe/${ref}`).then((r) => r);
      await new Promise((r) => setTimeout(r, 400));
      expect(calls).toBe(1); // the unsubscribe is waiting for the address lock
      release();
      const [g, u] = await Promise.all([granting, unsubscribing]);
      expect([g.status, u.status]).toEqual([200, 200]);
    } finally {
      spy.mockRestore();
    }
    const hash = emailHash(t.config.EMAIL_HASH_KEY, me.email);
    const rows = await t.prisma.consentRecord.findMany({ where: { emailHash: hash }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] });
    expect(rows.map((r) => [r.granted, r.source])).toEqual([[true, 'account'], [false, 'unsubscribe_link']]);
    expect(await t.prisma.emailSuppression.findUnique({ where: { emailHash: hash } })).toMatchObject({ scope: 'marketing' });
  });
});

describe('one-click unsubscribe', () => {
  it('bad HMAC and unknown id are the same 404; GET changes nothing and redirects with a fragment; POST twice records once', async () => {
    const me = await bookedCustomer('Unsub');
    const mail = t.app.get(MailService);
    const m = await t.prisma.$transaction((tx) => mail.enqueue({ to: me.email, templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', dedupeKey: `u:${randomUUID()}`, category: 'marketing', customerId: me.customerId }, tx));
    const ref = `${m.id}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, m.id)}`;
    const bad = await t.http().post(`/unsubscribe/${m.id}.${'0'.repeat(64)}`);
    const unknownId = randomUUID();
    const unknown = await t.http().post(`/unsubscribe/${unknownId}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, unknownId)}`);
    expect([bad.status, unknown.status]).toEqual([404, 404]);
    expect(bad.body).toEqual(unknown.body);
    const page = await t.http().get(`/unsubscribe/${ref}`);
    expect(page.status).toBe(303);
    expect(page.headers.location).toBe(`http://localhost:3000/unsubscribe#ref=${ref}`);
    expect(await t.prisma.consentRecord.count({ where: { customerId: me.customerId } })).toBe(0);
    // No Origin, no CSRF header: a mail client's one-click POST.
    expect((await t.http().post(`/unsubscribe/${ref}`).send('List-Unsubscribe=One-Click')).status).toBe(200);
    expect((await t.http().post(`/unsubscribe/${ref}`)).status).toBe(200);
    const rows = await t.prisma.consentRecord.findMany({ where: { customerId: me.customerId } });
    expect(rows.map((r) => [r.granted, r.source])).toEqual([[false, 'unsubscribe_link']]);
    expect(await t.prisma.emailSuppression.findUnique({ where: { emailHash: emailHash(t.config.EMAIL_HASH_KEY, me.email) } })).toMatchObject({ scope: 'marketing' });
  });

  it('one-click POSTs from one mail provider address are never refused; only wrong links are limited (review M1)', async () => {
    const mail = t.app.get(MailService);
    for (let i = 0; i < 40; i++) {
      const m = await t.prisma.$transaction((tx) => mail.enqueue({ to: uniqueEmail('bulk'), templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', dedupeKey: `b:${randomUUID()}`, category: 'marketing' }, tx));
      expect((await t.http().post(`/unsubscribe/${m.id}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, m.id)}`)).status).toBe(200);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await t.http().post(`/unsubscribe/${randomUUID()}.${'0'.repeat(64)}`)).status);
    // 30 wrong links a minute per address (earlier tests in this file may have used a few): 404s, then 429s only.
    const first429 = statuses.indexOf(429);
    expect(first429).toBeGreaterThanOrEqual(25);
    expect(statuses.slice(0, first429).every((x) => x === 404)).toBe(true);
    expect(statuses.slice(first429).every((x) => x === 429)).toBe(true);
    // The same valid link repeated: always 200, but after 20 an hour nothing more is done (no lock taken, no record).
    const same = await t.prisma.$transaction((tx) => mail.enqueue({ to: uniqueEmail('same'), templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', dedupeKey: `b:${randomUUID()}`, category: 'marketing' }, tx));
    const consent = t.app.get(ConsentService);
    const spy = vi.spyOn(consent, 'unsubscribe');
    try {
      for (let i = 0; i < 25; i++) expect((await t.http().post(`/unsubscribe/${same.id}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, same.id)}`)).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(20);
    } finally {
      spy.mockRestore();
    }
    // Failed attempts do not use the link up (round 3): 25 failures, then the real unsubscribe still happens.
    const flaky = await t.prisma.$transaction((tx) => mail.enqueue({ to: uniqueEmail('flaky'), templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', dedupeKey: `b:${randomUUID()}`, category: 'marketing' }, tx));
    const failing = vi.spyOn(consent, 'unsubscribe').mockRejectedValue(new Error('database down'));
    try {
      for (let i = 0; i < 25; i++) expect((await t.http().post(`/unsubscribe/${flaky.id}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, flaky.id)}`)).status).toBe(500);
    } finally {
      failing.mockRestore();
    }
    expect((await t.http().post(`/unsubscribe/${flaky.id}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, flaky.id)}`)).status).toBe(200);
    expect(await t.prisma.emailSuppression.findUnique({ where: { emailHash: emailHash(t.config.EMAIL_HASH_KEY, (await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: flaky.id } })).to) } })).toMatchObject({ scope: 'marketing' });
    // A valid link still goes through while wrong ones are being refused.
    const ok = await t.prisma.$transaction((tx) => mail.enqueue({ to: uniqueEmail('after'), templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', dedupeKey: `b:${randomUUID()}`, category: 'marketing' }, tx));
    expect((await t.http().post(`/unsubscribe/${ok.id}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, ok.id)}`)).status).toBe(200);
  });

  it('marketing_withdrawal_keeps_balance_reminders: a marketing suppression does not stop an automation email; an `all` one does', async () => {
    // The automation action checks the suppression scope (7.4); its test of `all` is in automations.test.ts. Here: the
    // rule itself, read from the same table the action reads.
    const email = uniqueEmail('rem');
    const mail = t.app.get(MailService);
    await mail.addSuppression(email, 'unsubscribed', 'marketing');
    expect(await mail.suppressionScope(email)).toBe('marketing');
    const stops = await t.prisma.emailSuppression.findFirst({ where: { emailHash: emailHash(t.config.EMAIL_HASH_KEY, email), scope: 'all' } });
    expect(stops).toBeNull();
    await mail.addSuppression(email, 'complaint', 'all');
    expect(await mail.suppressionScope(email)).toBe('all');
  });

  it('marketing mail carries the one-click headers (RFC 8058)', async () => {
    const me = await bookedCustomer('Hdr');
    await t.prisma.race.update({ where: { id: w.race.id }, data: { status: 'published' } });
    await t.prisma.alertSubscription.create({ data: { email: me.email, raceId: w.race.id, scope: 'race', status: 'confirmed', confirmedAt: new Date() } });
    const sub = await t.prisma.alertSubscription.findFirstOrThrow({ where: { email: me.email } });
    const mail = t.app.get(MailService);
    const m = await t.prisma.$transaction((tx) => mail.enqueue({ to: me.email, templateKey: 'alerts.package_open', templateVersion: 1, locale: 'en-AU', dedupeKey: `alerts:open:${w.pkg.id}:${sub.id}`, category: 'marketing', relatedEntityType: 'AlertSubscription', relatedEntityId: sub.id }, tx));
    expect(await mail.processSend(m.id)).toBe('sent');
    const msg = t.mail.sent.filter((x) => x.to === me.email).at(-1)!;
    expect(msg.headers?.['List-Unsubscribe']).toBe(`<${t.config.API_BASE_URL}/unsubscribe/${m.id}.${unsubscribeToken(t.config.EMAIL_HASH_KEY, m.id)}>`);
    expect(msg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});

describe('erasure requests from the account', () => {
  it('with a customer record: one open request and one staff task, however many times asked; staff see it', async () => {
    const me = await bookedCustomer('Ask');
    expect((await as(me).post('/account/privacy/erasure-request', {})).body.status).toBe('received');
    expect((await as(me).post('/account/privacy/erasure-request', {})).body.status).toBe('received');
    expect(await t.prisma.privacyRequest.count({ where: { customerId: me.customerId, kind: 'erasure' } })).toBe(1);
    expect(await t.prisma.task.count({ where: { entityType: 'Customer', entityId: me.customerId, sourceRef: `privacy:erasure:${me.customerId}`, status: 'open' } })).toBe(1);
    const view = await owner.get(`/admin/privacy/customers/${me.customerId}`);
    expect(view.status).toBe(200);
    expect(view.body.requests[0]).toMatchObject({ kind: 'erasure', status: 'received', requestedBy: 'customer' });
    expect(view.body.erasure).toEqual({ possible: false, blockedBy: 'open_booking' });
    expect(JSON.stringify(view.body)).not.toContain(me.email);
  });

  it('an archived customer (deletedAt) can still download, change consent and ask for erasure (review m7)', async () => {
    const me = await bookedCustomer('Arch');
    await t.prisma.customer.update({ where: { id: me.customerId }, data: { deletedAt: new Date() } });
    expect((await as(me).get('/account/privacy')).status).toBe(200);
    expect((await download(me)).status).toBe(200);
    expect((await as(me).put('/account/privacy/marketing-consent', { granted: false, wordingKey: MARKETING_WORDING_KEY })).status).toBe(200);
    expect((await as(me).post('/account/privacy/erasure-request', {})).body.status).toBe('received');
  });

  it('account-only erasure also clears the audit history and tasks of a complaint staff logged with the address (review round 2)', async () => {
    const me = await signInCustomer(t, uniqueEmail('ana'));
    const staff = await privacyStaff(t, { permissions: ['complaints.complaint.read', 'complaints.complaint.manage'] });
    const logged = await staff.post('/admin/complaints', { complainantName: 'Ana Complainant', complainantEmail: me.email.toUpperCase(), channel: 'email', category: 'service', summary: 'Ana summary', description: 'Ana words' });
    expect(logged.status, JSON.stringify(logged.body)).toBe(201);
    const id = logged.body.id as string;
    const { TasksService } = await import('../../../src/platform/common/tasks/tasks.service');
    await t.prisma.$transaction((tx) => t.app.get(TasksService).createSystemIn(tx, { title: 'Call Ana Complainant back', entityType: 'Complaint', entityId: id, sourceRef: `t:${randomUUID()}` }));
    const history = async () => JSON.stringify(await t.prisma.auditPiiValue.findMany({ where: { auditLog: { OR: [{ entityType: 'Complaint', entityId: id }, { entityType: 'Task' }] } }, select: { before: true, after: true } }));
    expect(await history()).toContain('Ana Complainant');
    expect((await as(me).post('/account/privacy/erasure-request', { confirm: true })).body.status).toBe('completed');
    expect(await history()).not.toMatch(/Ana Complainant|Ana words|Ana summary/i);
    expect((await history()).toLowerCase()).not.toContain(me.email.toLowerCase());
    const tasks = await t.prisma.task.findMany({ where: { entityType: 'Complaint', entityId: id } });
    expect(tasks.every((k) => k.title === '[redacted]')).toBe(true);
    expect(await t.prisma.searchDocument.count({ where: { entityType: 'Task', entityId: { in: tasks.map((k) => k.id) } } })).toBe(0);
    expect(await t.prisma.complaint.findUniqueOrThrow({ where: { id } })).toMatchObject({ complainantName: '[redacted]', complainantEmail: null, summary: '[redacted]' });
  });

  it('without a customer record: confirmation required, then the sign-in account is erased and signed out', async () => {
    const me = await signInCustomer(t, uniqueEmail('gone'));
    // A complaint logged with the address and no customer is theirs too (review m6): in the export, redacted on erasure.
    const cp = await t.prisma.complaint.create({ data: { reference: `CP-${'ABCDEFGHJK'[Math.floor(Math.random() * 10)]}${Date.now().toString(36).toUpperCase().replace(/[ILOU]/g, 'A').slice(-5)}`, complainantName: 'Gone Person', complainantEmail: me.email.toUpperCase(), channel: 'email', category: 'service', summary: 'Gone summary', description: 'Gone words', receivedDate: new Date(), acknowledgeDueDate: new Date(), resolveDueDate: new Date(), createdById: owner.staff.id } });
    expect(JSON.stringify(parsed((await download(me)).body))).toContain('Gone words');
    expect((await as(me).post('/account/privacy/erasure-request', {})).status).toBe(422);
    const r = await as(me).post('/account/privacy/erasure-request', { confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('completed');
    const u = await t.prisma.user.findUniqueOrThrow({ where: { id: me.userId } });
    expect(u).toMatchObject({ email: `erased+${me.userId}@invalid`, status: 'disabled' });
    expect(await t.prisma.session.count({ where: { userId: me.userId } })).toBe(0);
    expect((await as(me).get('/account/privacy')).status).toBe(401);
    expect(await t.prisma.auditPiiValue.count({ where: { subjectUserId: me.userId } })).toBe(0);
    expect(await t.prisma.complaint.findUniqueOrThrow({ where: { id: cp.id } })).toMatchObject({ complainantName: '[redacted]', complainantEmail: null, description: '[redacted]', customerId: null });
  });
});
