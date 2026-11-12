// Editable email and document templates (task 5.4): the panel routes, preview, the one-active rule, and a booking email
// that uses wording staff put into use. Real database, real mail send step with a capturing sender.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsService } from '../../../src/platform/events/events.service';
import { MailService } from '../../../src/platform/mail/mail.service';
import { TemplatesService } from '../../../src/modules/templates';
import { TEMPLATES_PERMISSIONS } from '../../../src/modules/templates';
import { TestApp, makeApp } from '../../support/auth';
import { Client, staffClient } from '../../support/catalogue';
import { closeCatalogue } from '../../support/catalogue';
import { cleanBookingEvents, requestBody } from '../../support/bookings';
import { crmStaff, linkedCustomer, makeQuote, sendQuote } from '../../support/crm';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Client;
const ALL = Object.values(TEMPLATES_PERMISSIONS);
const wipe = () => t.prisma.$executeRawUnsafe('DELETE FROM message_templates');

beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, ALL);
  await wipe();
});
beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await t.close();
});

const draft = async (over: Record<string, unknown> = {}, channel = 'email') => {
  const res = await admin.post(`/admin/templates/${channel}`, { key: 'crm.booking_approved', subject: 'Approved {{reference}}', body: 'Hi {{givenName}}, {{trip}} for {{total}}. {{link}}\n{{brandName}}', ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; version: number; revision: number; status: string };
};

describe('template_definitions', () => {
  it('lists the known templates with the variables each may use', async () => {
    const res = await admin.get('/admin/templates/definitions');
    expect(res.status).toBe(200);
    const keys = res.body.items.map((d: { channel: string; key: string }) => `${d.channel}:${d.key}`);
    expect(keys).toEqual(expect.arrayContaining(['email:crm.booking_approved', 'email:crm.quote_sent', 'document:confirmation', 'document:itinerary', 'document:voucher', 'document:receipt']));
    const approved = res.body.items.find((d: { key: string }) => d.key === 'crm.booking_approved');
    expect(approved.variables.map((v: { name: string }) => v.name)).toEqual(expect.arrayContaining(['givenName', 'reference', 'trip', 'total', 'link']));
  });
});

describe('template_wording_is_checked', () => {
  it('refuses a variable the template does not have, braces that are not a variable, and an unknown key', async () => {
    const bad = async (over: Record<string, unknown>) => (await admin.post('/admin/templates/email', { key: 'crm.booking_approved', subject: 'S {{reference}}', body: 'B', ...over }));
    expect((await bad({ body: 'Hi {{passportNumber}}' })).body.code).toBe('template_wording_invalid');
    expect((await bad({ subject: 'Hi {{ first name }}' })).body.code).toBe('template_wording_invalid');
    expect((await bad({ body: 'Hi {{givenName' })).status).toBe(422);
    expect((await bad({ key: 'nothing.here' })).body.code).toBe('template_unknown_key');
    expect((await bad({ key: 'confirmation' })).body.code).toBe('template_unknown_key'); // a document key is not an email
    expect((await bad({ subject: '' })).body.code).toBe('template_subject_required');
    expect((await bad({ subject: 'a\nBcc: x@example.test' })).status).toBe(422);
    expect(await t.prisma.messageTemplate.count()).toBe(0);
  });

  it('a document needs no subject line, and an unknown channel is a 404', async () => {
    await draft({ key: 'voucher', subject: '', body: 'Voucher for {{customerName}}' }, 'document');
    expect((await admin.get('/admin/templates/sms')).status).toBe(404);
  });
});

describe('template_revisions', () => {
  it('a change is a new draft revision; putting it into use retires the one before; only one is ever in use', async () => {
    const a = await draft();
    expect(a.revision).toBe(1);
    const aOn = (await admin.post(`/admin/templates/email/${a.id}/activate`, { version: a.version })).body;
    expect(aOn.status).toBe('active');

    const b = await draft({ body: 'Second wording {{givenName}}' });
    expect(b.revision).toBe(2);
    expect((await admin.post(`/admin/templates/email/${b.id}/activate`, { version: b.version })).body.status).toBe('active');

    const rows = await t.prisma.messageTemplate.findMany({ orderBy: { revision: 'asc' } });
    expect(rows.map((r) => `${r.revision}:${r.status}`)).toEqual(['1:archived', '2:active']);
    // The database refuses a second live revision even if the application were wrong.
    await expect(t.prisma.messageTemplate.update({ where: { id: a.id }, data: { status: 'active' } })).rejects.toThrow();
  });

  it('a revision that was in use is never edited; a draft can be', async () => {
    const a = await draft();
    const edited = await admin.patch(`/admin/templates/email/${a.id}`, { version: a.version, body: 'Changed {{givenName}}' });
    expect(edited.status).toBe(200);
    expect(edited.body.body).toBe('Changed {{givenName}}');
    const on = (await admin.post(`/admin/templates/email/${a.id}/activate`, { version: edited.body.version })).body;
    const again = await admin.patch(`/admin/templates/email/${a.id}`, { version: on.version, body: 'Sneaky' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('template_not_draft');
    expect((await admin.post(`/admin/templates/email/${a.id}/activate`, { version: on.version })).body.code).toBe('template_not_draft');
  });

  it('a stale version is a 409 and changes nothing', async () => {
    const a = await draft();
    expect((await admin.patch(`/admin/templates/email/${a.id}`, { version: a.version, body: 'One {{givenName}}' })).status).toBe(200);
    const stale = await admin.patch(`/admin/templates/email/${a.id}`, { version: a.version, body: 'Two {{givenName}}' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect((await t.prisma.messageTemplate.findUniqueOrThrow({ where: { id: a.id } })).body).toBe('One {{givenName}}');
  });

  it('two people activating at once leave exactly one in use', async () => {
    const a = await draft();
    const b = await draft({ body: 'Other {{givenName}}' });
    const [x, y] = await Promise.all([
      admin.post(`/admin/templates/email/${a.id}/activate`, { version: a.version }),
      admin.post(`/admin/templates/email/${b.id}/activate`, { version: b.version }),
    ]);
    expect([x.status, y.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(await t.prisma.messageTemplate.count({ where: { status: 'active' } })).toBe(1);
  });

  it('archiving the one in use hands back to the built-in wording; each step is audited', async () => {
    const a = await draft();
    const on = (await admin.post(`/admin/templates/email/${a.id}/activate`, { version: a.version })).body;
    expect((await admin.post(`/admin/templates/email/${a.id}/archive`, { version: on.version })).body.status).toBe('archived');
    expect(await t.app.get(TemplatesService).activeWording(t.prisma, 'email', 'crm.booking_approved', 'en-AU')).toBeNull();
    const actions = (await t.prisma.auditLog.findMany({ where: { entityId: a.id }, select: { action: true } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['templates.template.created', 'templates.template.activated', 'templates.template.archived']));
  });
});

describe('template_preview', () => {
  it('previews unsaved wording with sample data and lists the variables', async () => {
    const res = await admin.post('/admin/templates/email/preview', { key: 'crm.booking_approved', subject: 'Approved {{reference}}', body: 'Hi {{givenName}}, total {{total}}.' });
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    expect(res.body.subject).toBe('Approved BK-7QX4MD');
    expect(res.body.body).toBe('Hi Alex, total A$2,450.00.');
    expect(res.body.variables.length).toBeGreaterThan(3);
  });

  it('reports problems instead of rendering when the wording is wrong', async () => {
    const res = await admin.post('/admin/templates/email/preview', { key: 'crm.booking_approved', subject: 'S', body: 'Hi {{nope}} {{ bad one }}' });
    expect(res.status).toBe(200);
    expect(res.body.body).toBeNull();
    expect(res.body.problems).toEqual([{ field: 'body', kind: 'unknown_variable', name: 'nope' }, { field: 'body', kind: 'malformed' }]);
  });

  it('previews a saved template, and a document as a PDF', async () => {
    const e = await draft();
    expect((await admin.get(`/admin/templates/email/${e.id}/preview`)).body.subject).toBe('Approved BK-7QX4MD');
    const d = await draft({ key: 'confirmation', subject: 'Confirmation {{reference}}', body: 'Traveller: {{customerName}}\nTrip: {{trip}}' }, 'document');
    const pdf = await admin.get(`/admin/templates/document/${d.id}/pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const s = (pdf.body as Buffer).toString('latin1');
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s).toContain('(Confirmation BK-7QX4MD) Tj');
    expect(s).toContain('Traveller: Alex Sample');
    expect((await admin.get(`/admin/templates/email/${e.id}/pdf`)).status).toBe(404);
  });

  it('renders a document from the starter wording when none is in use, and from the live one when there is', async () => {
    const svc = t.app.get(TemplatesService);
    const vars = { customerName: 'Pat Real', reference: 'BK-1', trip: 'Race', departureDate: 'a', returnDate: 'b', total: 'A$1.00', itinerary: 'x' };
    const starter = await svc.renderDocument(t.prisma, 'voucher', 'en-AU', vars);
    expect(starter.revision).toBeNull();
    expect(starter.pdf.toString('latin1')).toContain('Pat Real');
    const d = await draft({ key: 'voucher', subject: 'Custom voucher', body: 'Only {{reference}}' }, 'document');
    await admin.post(`/admin/templates/document/${d.id}/activate`, { version: d.version });
    const live = await svc.renderDocument(t.prisma, 'voucher', 'en-AU', vars);
    expect(live.revision).toBe(1);
    expect(live.pdf.toString('latin1')).toContain('(Custom voucher) Tj');
  });
});

describe('template_permissions', () => {
  it('reading, drafting and putting into use are separate permissions', async () => {
    const reader = await staffClient(t, [TEMPLATES_PERMISSIONS.read]);
    const writer = await staffClient(t, [TEMPLATES_PERMISSIONS.read, TEMPLATES_PERMISSIONS.manage]);
    const a = await draft();
    expect((await reader.get('/admin/templates/email')).status).toBe(200);
    expect((await reader.post('/admin/templates/email', { key: 'crm.booking_approved', subject: 'S', body: 'B' })).status).toBe(403);
    expect((await writer.post('/admin/templates/email', { key: 'crm.booking_approved', subject: 'S', body: 'B' })).status).toBe(201);
    expect((await writer.post(`/admin/templates/email/${a.id}/activate`, { version: a.version })).status).toBe(403);
    expect((await t.http().get('/admin/templates/email')).status).toBe(401);
    expect(await t.prisma.messageTemplate.count({ where: { status: 'active' } })).toBe(0);
  });
});

describe('booking_email_uses_live_template', () => {
  let staff: Awaited<ReturnType<typeof crmStaff>>;
  let w: PricedWorld;
  beforeAll(async () => {
    staff = await crmStaff(t);
    w = await pricedWorld(staff);
    for (const id of [w.roomPoolId, w.entryPoolId, w.extraPoolId]) {
      const p = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } });
      await staff.patch(`/admin/catalogue/pools/${id}`, { capacity: 500, version: p.version });
    }
  });
  afterAll(async () => {
    await cleanBookingEvents(t);
    await closeCatalogue(t);
  });

  async function approveAndSend(customerId: string) {
    const booking = await t.prisma.booking.findFirstOrThrow({ where: { customerId }, orderBy: { createdAt: 'desc' } });
    expect((await staff.post(`/admin/bookings/${booking.id}/approve`, { version: booking.version })).status).toBe(200);
    const events = t.app.get(EventsService);
    await events.dispatchPending(1000);
    const pending = await t.prisma.eventDelivery.findMany({ where: { consumer: 'crm.booking_emails', status: 'pending' }, select: { id: true } });
    for (const d of pending) await events.processDelivery(d.id);
    const queued = await t.prisma.outboundEmail.findMany({ where: { customerId, status: 'queued', templateKey: 'crm.booking_approved' } });
    const before = t.mail.sent.length;
    for (const e of queued) await t.app.get(MailService).processSend(e.id);
    return { sent: t.mail.sent.slice(before), booking };
  }

  it('sends the wording in use, with real values filled in; without one it sends the built-in wording', async () => {
    const a = await linkedCustomer(t);
    await a.client.request(requestBody(w));
    const d = await draft({ subject: 'GOOD NEWS {{reference}}', body: 'Hello {{givenName}}\nTrip: {{trip}}\nTotal: {{total}}\n{{link}}\n-- {{brandName}}' });
    await admin.post(`/admin/templates/email/${d.id}/activate`, { version: d.version });
    const { sent, booking } = await approveAndSend(a.customerId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe(`GOOD NEWS ${booking.reference}`);
    const who = await t.prisma.customer.findUniqueOrThrow({ where: { id: a.customerId } });
    expect(sent[0]!.text).toContain(`Hello ${who.givenName}`);
    expect(sent[0]!.text).toContain(`/trips/requests/${booking.reference}`);
    expect(sent[0]!.text).not.toContain('{{');

    const b = await linkedCustomer(t);
    await b.client.request(requestBody(w));
    await t.prisma.messageTemplate.updateMany({ data: { status: 'archived' } });
    const plain = await approveAndSend(b.customerId);
    expect(plain.sent[0]!.subject).toContain('is approved');
  });

  it('the quote email uses the wording in use too, with the hold time filled in', async () => {
    const a = await linkedCustomer(t);
    const d = await draft({ key: 'crm.quote_sent', subject: 'Quote {{reference}}', body: '{{givenName}}: {{total}} held until {{expiresAt}}. {{link}}' });
    await admin.post(`/admin/templates/email/${d.id}/activate`, { version: d.version });
    const q = await sendQuote(staff, await makeQuote(staff, a.customerId, w));
    const queued = await t.prisma.outboundEmail.findMany({ where: { customerId: a.customerId, status: 'queued', templateKey: 'crm.quote_sent' } });
    expect(queued).toHaveLength(1);
    const before = t.mail.sent.length;
    await t.app.get(MailService).processSend(queued[0]!.id);
    const mail = t.mail.sent[before]!;
    expect(mail.subject).toBe(`Quote ${q.reference}`);
    expect(mail.text).toMatch(/held until .*\d{4}/);
    expect(mail.text).toContain(`/quotes/${q.reference}`);
    expect(mail.text).not.toContain('{{');
  });
});
