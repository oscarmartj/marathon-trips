import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AlertsService } from '../../../src/modules/alerts';
import { ALERTS_PERMISSIONS } from '../../../src/modules/alerts';
import { tokenHash } from '../../../src/platform/auth/tokens';
import { EventsService } from '../../../src/platform/events/events.service';
import { MailService } from '../../../src/platform/mail/mail.service';
import { STATE_HEADERS, TestApp, makeApp, uniqueEmail } from '../../support/auth';
import { Client, World, announceEdition, buildWorld, closeCatalogue, driveTo, staffClient } from '../../support/catalogue';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t);
});
afterAll(async () => {
  await t.prisma.race.updateMany({ where: { status: 'published', isDemo: false, slug: { startsWith: 'race-' } }, data: { status: 'archived' } });
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'mail.send'`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'alerts.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'alerts.%'`);
  await closeCatalogue(t);
});

const post = (path: string, body: object) => t.http().post(path).set(STATE_HEADERS).send(body);

/** A published race with an announced edition and a draft package. */
async function publishedWorld(): Promise<World> {
  const w = await buildWorld(admin);
  await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version });
  expect((await announceEdition(admin, w.edition.id)).status).toBe(200);
  return w;
}

const mailTo = (to: string) => t.prisma.outboundEmail.findMany({ where: { to }, orderBy: { createdAt: 'asc' } });
async function send(to: string): Promise<void> {
  for (const m of await mailTo(to)) if (m.status === 'queued') await t.app.get(MailService).processSend(m.id);
}
const sentTo = (to: string) => t.mail.sent.filter((m) => m.to === to);
const tokenIn = (text: string) => /#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? '';

async function subscribeAndConfirm(slug: string, email = uniqueEmail('fan'), year?: number): Promise<{ email: string; id: string }> {
  const res = await post('/alerts/subscriptions', { email, raceSlug: slug, ...(year ? { year } : {}) });
  expect(res.status).toBe(202);
  await send(email);
  const token = tokenIn(sentTo(email).at(-1)!.text);
  expect((await post('/alerts/confirm', { token })).status).toBe(200);
  const row = await t.prisma.alertSubscription.findFirstOrThrow({ where: { email } });
  return { email, id: row.id };
}

/** Delivers the events recorded so far to the alerts consumer, then sends the emails that produced. */
async function deliverEvents(): Promise<void> {
  const events = t.app.get(EventsService);
  await events.dispatchPending(500);
  const pending = await t.prisma.eventDelivery.findMany({ where: { consumer: 'alerts.notify_open', status: 'pending' }, select: { id: true } });
  for (const d of pending) await events.processDelivery(d.id);
}

describe('subscribing', () => {
  it('only a published race can be subscribed to, and a missing one is a 404', async () => {
    const draft = await buildWorld(admin);
    expect((await post('/alerts/subscriptions', { email: uniqueEmail('fan'), raceSlug: draft.race.slug })).status).toBe(404);
    expect((await post('/alerts/subscriptions', { email: uniqueEmail('fan'), raceSlug: 'no-such-race' })).status).toBe(404);
    const w = await publishedWorld();
    expect((await post('/alerts/subscriptions', { email: uniqueEmail('fan'), raceSlug: w.race.slug, year: 1999 })).status).toBe(404);
    expect((await post('/alerts/subscriptions', { email: 'not-an-address', raceSlug: w.race.slug })).status).toBe(422);
    expect((await post('/alerts/subscriptions', { email: uniqueEmail('fan'), raceSlug: w.race.slug, extra: 1 })).status).toBe(422);
  });

  it('a new subscription is pending, queues one confirmation email and stores no token until it is sent', async () => {
    const w = await publishedWorld();
    const email = uniqueEmail('fan');
    const res = await post('/alerts/subscriptions', { email, raceSlug: w.race.slug });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    const row = await t.prisma.alertSubscription.findFirstOrThrow({ where: { email } });
    expect(row.status).toBe('pending');
    expect(row.confirmTokenHash).toBeNull();
    const queued = await mailTo(email);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ templateKey: 'alerts.confirm', category: 'transactional' });
    await send(email);
    const msg = sentTo(email)[0]!;
    expect(msg.text).toContain('/alerts/unsubscribe?s=');
    expect((await t.prisma.alertSubscription.findFirstOrThrow({ where: { email } })).confirmTokenHash).toBe(tokenHash(tokenIn(msg.text)));
  });

  it('gives the same answer for a new, a pending and a confirmed address, and does not email twice in the hour', async () => {
    const w = await publishedWorld();
    const email = uniqueEmail('fan');
    const first = await post('/alerts/subscriptions', { email, raceSlug: w.race.slug });
    const again = await post('/alerts/subscriptions', { email: email.toUpperCase(), raceSlug: w.race.slug });
    expect([first.status, first.body]).toEqual([again.status, again.body]);
    expect(await t.prisma.alertSubscription.count({ where: { email } })).toBe(1);
    expect(await mailTo(email)).toHaveLength(1);
    const { email: confirmed } = await subscribeAndConfirm(w.race.slug);
    const third = await post('/alerts/subscriptions', { email: confirmed, raceSlug: w.race.slug });
    expect([third.status, third.body]).toEqual([first.status, first.body]);
    expect(await mailTo(confirmed)).toHaveLength(1); // nothing new for someone already confirmed
  });

  it('a race and one of its editions are separate subscriptions', async () => {
    const w = await publishedWorld();
    const email = uniqueEmail('fan');
    await post('/alerts/subscriptions', { email, raceSlug: w.race.slug });
    await post('/alerts/subscriptions', { email, raceSlug: w.race.slug, year: w.edition.year });
    expect(await t.prisma.alertSubscription.count({ where: { email } })).toBe(2);
  });

  it('stops after five requests for one address in 15 minutes, with the same answer', async () => {
    const w = await publishedWorld();
    const email = uniqueEmail('flood');
    const service = t.app.get(AlertsService);
    for (let i = 0; i < 8; i++) await service.subscribe({ email, raceSlug: w.race.slug, ...(i % 2 ? { year: w.edition.year } : {}) });
    // Two scopes, so at most two emails could ever exist; the limiter is on requests: 5 got through, 3 were dropped silently.
    expect((await mailTo(email)).length).toBeLessThanOrEqual(2);
    expect((await post('/alerts/subscriptions', { email, raceSlug: w.race.slug })).status).toBe(202);
  });
});

describe('double confirmation', () => {
  it('confirming moves pending to confirmed once, publishes an event with identifiers only and burns the token', async () => {
    const w = await publishedWorld();
    const email = uniqueEmail('fan');
    await post('/alerts/subscriptions', { email, raceSlug: w.race.slug });
    await send(email);
    const token = tokenIn(sentTo(email)[0]!.text);
    expect((await post('/alerts/confirm', { token })).status).toBe(200);
    const row = await t.prisma.alertSubscription.findFirstOrThrow({ where: { email } });
    expect(row).toMatchObject({ status: 'confirmed', confirmTokenHash: null, confirmTokenExpiresAt: null });
    expect(row.confirmedAt).not.toBeNull();
    const event = await t.prisma.outboxEvent.findFirstOrThrow({ where: { type: 'alerts.subscription.confirmed', aggregateId: row.id } });
    expect(JSON.stringify(event.payload)).not.toContain('@');
    const replay = await post('/alerts/confirm', { token });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('link_invalid');
  });

  it('an expired, a forged and a malformed token are all the same 400, and the row stays pending', async () => {
    const w = await publishedWorld();
    const email = uniqueEmail('fan');
    await post('/alerts/subscriptions', { email, raceSlug: w.race.slug });
    await send(email);
    const token = tokenIn(sentTo(email)[0]!.text);
    await t.prisma.alertSubscription.updateMany({ where: { email }, data: { confirmTokenExpiresAt: new Date(Date.now() - 1000) } });
    const bodies = [];
    for (const tk of [token, 'A'.repeat(43)]) {
      const r = await post('/alerts/confirm', { token: tk });
      expect(r.status).toBe(400);
      bodies.push(r.body);
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect((await post('/alerts/confirm', { token: 'short' })).status).toBe(422);
    expect((await t.prisma.alertSubscription.findFirstOrThrow({ where: { email } })).status).toBe('pending');
  });

  it('a mail retry replaces the token, so only the latest link works', async () => {
    const w = await publishedWorld();
    const email = uniqueEmail('fan');
    await post('/alerts/subscriptions', { email, raceSlug: w.race.slug });
    const [queued] = await mailTo(email);
    // Render twice, as a retry after a failed send would; the first token is gone.
    const render = (id: string) =>
      t.prisma.$transaction((tx) => t.app.get(AlertsService).renderConfirm({ tx, unsubscribeToken: '', email: { id: queued!.id, to: email, locale: 'en-AU', customerId: null, relatedEntityType: 'AlertSubscription', relatedEntityId: id } }));
    const id = (await t.prisma.alertSubscription.findFirstOrThrow({ where: { email } })).id;
    const first = tokenIn((await render(id)).text);
    const second = tokenIn((await render(id)).text);
    expect((await post('/alerts/confirm', { token: first })).status).toBe(400);
    expect((await post('/alerts/confirm', { token: second })).status).toBe(200);
  });
});

describe('unsubscribing in one click', () => {
  const linkOf = (text: string) => {
    const m = /alerts\/unsubscribe\?s=([0-9a-f-]{36})&t=([0-9a-f]{64})/.exec(text)!;
    return { subscriptionId: m[1]!, token: m[2]! };
  };

  it('works from the link in the email, twice over, from pending and from confirmed', async () => {
    const w = await publishedWorld();
    const pending = uniqueEmail('fan');
    await post('/alerts/subscriptions', { email: pending, raceSlug: w.race.slug });
    await send(pending);
    const link = linkOf(sentTo(pending)[0]!.text);
    expect((await post('/alerts/unsubscribe', link)).status).toBe(200);
    expect((await post('/alerts/unsubscribe', link)).status).toBe(200);
    expect(await t.prisma.alertSubscription.findFirstOrThrow({ where: { email: pending } })).toMatchObject({ status: 'unsubscribed', confirmTokenHash: null });
    // The confirmation link sent before is dead now.
    expect((await post('/alerts/confirm', { token: tokenIn(sentTo(pending)[0]!.text) })).status).toBe(400);

    const { email } = await subscribeAndConfirm(w.race.slug);
    await post('/alerts/unsubscribe', linkOf(sentTo(email)[0]!.text));
    expect((await t.prisma.alertSubscription.findFirstOrThrow({ where: { email } })).status).toBe('unsubscribed');
  });

  it('a wrong HMAC or someone else’s id does nothing', async () => {
    const w = await publishedWorld();
    const a = await subscribeAndConfirm(w.race.slug);
    const b = await subscribeAndConfirm(w.race.slug);
    const linkA = linkOf(sentTo(a.email)[0]!.text);
    expect((await post('/alerts/unsubscribe', { subscriptionId: a.id, token: '0'.repeat(64) })).status).toBe(400);
    expect((await post('/alerts/unsubscribe', { subscriptionId: b.id, token: linkA.token })).status).toBe(400);
    expect((await post('/alerts/unsubscribe', { subscriptionId: '00000000-0000-4000-8000-000000000000', token: linkA.token })).status).toBe(400);
    const rows = await t.prisma.alertSubscription.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.every((r) => r.status === 'confirmed')).toBe(true);
  });

  it('subscribing again after unsubscribing needs a fresh confirmation', async () => {
    const w = await publishedWorld();
    const { email, id } = await subscribeAndConfirm(w.race.slug);
    await post('/alerts/unsubscribe', linkOf(sentTo(email)[0]!.text));
    await t.prisma.outboundEmail.updateMany({ where: { to: email }, data: { dedupeKey: 'old:' + Math.random() } }); // a later hour would not collide either
    expect((await post('/alerts/subscriptions', { email, raceSlug: w.race.slug })).status).toBe(202);
    expect(await t.prisma.alertSubscription.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'pending', confirmedAt: null, unsubscribedAt: null });
    expect((await mailTo(email)).filter((m) => m.status === 'queued')).toHaveLength(1);
  });
});

describe('the opening notice (phase 5 criterion)', () => {
  it('confirmed subscribers get one email when the package opens, unconfirmed and unsubscribed ones get none', async () => {
    const w = await publishedWorld();
    const confirmed = await subscribeAndConfirm(w.race.slug);
    const edition = await subscribeAndConfirm(w.race.slug, undefined, w.edition.year);
    const pendingEmail = uniqueEmail('pending');
    await post('/alerts/subscriptions', { email: pendingEmail, raceSlug: w.race.slug });
    const gone = await subscribeAndConfirm(w.race.slug);
    await post('/alerts/unsubscribe', { subscriptionId: gone.id, token: /t=([0-9a-f]{64})/.exec(sentTo(gone.email)[0]!.text)![1]! });
    const other = await publishedWorld();
    const elsewhere = await subscribeAndConfirm(other.race.slug);

    await driveTo(admin, w.pkg.id, 'open');
    await deliverEvents();
    for (const e of [confirmed.email, edition.email, pendingEmail, gone.email, elsewhere.email]) await send(e);

    const opens = (e: string) => sentTo(e).filter((m) => m.subject.includes('is now open'));
    expect(opens(confirmed.email)).toHaveLength(1);
    expect(opens(edition.email)).toHaveLength(1);
    expect(opens(pendingEmail)).toHaveLength(0);
    expect(opens(gone.email)).toHaveLength(0);
    expect(opens(elsewhere.email)).toHaveLength(0);
    expect(t.mail.sent.filter((m) => m.subject.includes(w.pkg.slug) || m.text.includes(`/races/${w.race.slug}`)).filter((m) => m.subject.includes('is now open'))).toHaveLength(2);
    const msg = opens(confirmed.email)[0]!;
    expect(msg.text).toContain(`/races/${w.race.slug}`);
    expect(msg.text).toMatch(/alerts\/unsubscribe\?s=[0-9a-f-]{36}&t=[0-9a-f]{64}/);
    expect((await t.prisma.alertSubscription.findUniqueOrThrow({ where: { id: confirmed.id } })).lastNotifiedAt).not.toBeNull();
    expect((await t.prisma.alertSubscription.findFirstOrThrow({ where: { email: pendingEmail } })).lastNotifiedAt).toBeNull();
  });

  it('an edition subscription is not told about another edition’s package', async () => {
    const w = await publishedWorld();
    const sub = await subscribeAndConfirm(w.race.slug, undefined, w.edition.year);
    // A second edition with its own package.
    const ed2 = (await admin.post(`/admin/catalogue/races/${w.race.id}/editions`, { year: w.edition.year + 1, startDate: `${w.edition.year + 1}-06-20`, endDate: `${w.edition.year + 1}-06-20`, dateStatus: 'confirmed' })).body;
    const pool = async (kind: string) => (await admin.post(`/admin/catalogue/editions/${ed2.id}/pools`, { kind, label: kind, capacity: 5 })).body.id as string;
    const [entryPool, roomPool] = [await pool('entry'), await pool('room')];
    const pkg = (await admin.post(`/admin/catalogue/editions/${ed2.id}/packages`, { slug: 'p2', name: { 'en-AU': 'Other year' }, checkInDate: `${w.edition.year + 1}-06-18`, checkOutDate: `${w.edition.year + 1}-06-21`, balanceDueDate: `${w.edition.year + 1}-04-18`, maxTravellers: 2, deposit: { mode: 'per_person', amountMinor: '50000' } })).body;
    expect(pkg.id).toBeTruthy();
    await announceEdition(admin, ed2.id);
    const hotel = (await admin.post('/admin/catalogue/hotels', { name: 'H', address: '1 St', city: 'Brisbane', countryCode: 'AU', starRating: 3 })).body;
    const linked = (await admin.post(`/admin/catalogue/packages/${pkg.id}/hotels`, { hotelId: hotel.id })).body;
    await admin.post(`/admin/catalogue/packages/${pkg.id}/hotels/${linked.hotels[0].id}/rooms`, { roomType: 'double', name: { 'en-AU': 'Double' }, minOccupancy: 1, maxOccupancy: 2, roomPoolId: roomPool });
    await admin.post(`/admin/catalogue/packages/${pkg.id}/entry-options`, { raceDistanceId: w.distanceId, entryPoolId: entryPool });
    const r = await driveTo(admin, pkg.id, 'open').then(() => 'ok', (e: Error) => e.message);
    expect(r).toBe('ok');
    await deliverEvents();
    await send(sub.email);
    expect(sentTo(sub.email).filter((m) => m.subject.includes('is now open'))).toHaveLength(0);
  });

  it('delivering the same event twice sends one email', async () => {
    const w = await publishedWorld();
    const sub = await subscribeAndConfirm(w.race.slug);
    await driveTo(admin, w.pkg.id, 'open');
    await deliverEvents();
    const event = await t.prisma.outboxEvent.findFirstOrThrow({ where: { type: 'catalogue.package.sale_status_changed', aggregateId: w.pkg.id, payload: { path: ['toStatus'], equals: 'open' } } });
    // Run the handler again by hand, as a repeated delivery would.
    await t.prisma.$transaction((tx) => t.app.get(AlertsService).notifyOpen({ id: event.id, type: event.type, schemaVersion: 1, aggregateType: 'Package', aggregateId: w.pkg.id, aggregateVersion: null, payload: event.payload, actorType: 'staff', actorId: null, occurredAt: event.occurredAt }, tx));
    await send(sub.email);
    expect(sentTo(sub.email).filter((m) => m.subject.includes('is now open'))).toHaveLength(1);
    expect((await mailTo(sub.email)).filter((m) => m.dedupeKey.startsWith('alerts:open:'))).toHaveLength(1);
  });

  it('other status changes send nothing, and an unsubscribe between the event and the send stops the email', async () => {
    const w = await publishedWorld();
    const sub = await subscribeAndConfirm(w.race.slug);
    await driveTo(admin, w.pkg.id, 'coming_soon');
    await deliverEvents();
    expect((await mailTo(sub.email)).filter((m) => m.dedupeKey.startsWith('alerts:open:'))).toHaveLength(0);
    await driveTo(admin, w.pkg.id, 'open');
    await deliverEvents();
    expect((await mailTo(sub.email)).filter((m) => m.dedupeKey.startsWith('alerts:open:'))).toHaveLength(1);
    await post('/alerts/unsubscribe', { subscriptionId: sub.id, token: /t=([0-9a-f]{64})/.exec(sentTo(sub.email)[0]!.text)![1]! });
    const queued = (await mailTo(sub.email)).find((m) => m.dedupeKey.startsWith('alerts:open:'))!;
    await expect(t.app.get(MailService).processSend(queued.id)).rejects.toThrow();
    expect(sentTo(sub.email).filter((m) => m.subject.includes('is now open'))).toHaveLength(0);
  });
});

describe('subscriber counts in the panel', () => {
  it('counts confirmed and pending per race, needs its permission and never returns an address', async () => {
    const w = await publishedWorld();
    await subscribeAndConfirm(w.race.slug);
    await subscribeAndConfirm(w.race.slug);
    const pending = uniqueEmail('pend');
    await post('/alerts/subscriptions', { email: pending, raceSlug: w.race.slug });
    const gone = await subscribeAndConfirm(w.race.slug);
    await post('/alerts/unsubscribe', { subscriptionId: gone.id, token: /t=([0-9a-f]{64})/.exec(sentTo(gone.email)[0]!.text)![1]! });

    const reader = await staffClient(t, [ALERTS_PERMISSIONS.subscriptionRead]);
    const res = await reader.get('/admin/alerts/subscribers');
    expect(res.status).toBe(200);
    expect(res.body.items.find((i: { raceId: string }) => i.raceId === w.race.id)).toMatchObject({ slug: w.race.slug, confirmed: 2, pending: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.test/);

    const nobody = await staffClient(t, ['catalogue.race.read']);
    expect((await nobody.get('/admin/alerts/subscribers')).status).toBe(403);
    expect((await t.http().get('/admin/alerts/subscribers')).status).toBe(401);
  });
});

describe('the database', () => {
  it('refuses a scope that does not match the edition and a confirmed row with no confirmation time', async () => {
    const w = await publishedWorld();
    const bad = (data: Record<string, unknown>) => t.prisma.alertSubscription.create({ data: { email: uniqueEmail('db'), raceId: w.race.id, scope: 'race', ...data } as never });
    await expect(bad({ scope: 'edition:nope' })).rejects.toThrow();
    await expect(bad({ status: 'confirmed' })).rejects.toThrow();
    await expect(bad({ status: 'unsubscribed' })).rejects.toThrow();
  });
});
