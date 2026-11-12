import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMON_PERMISSIONS_KEYS as K } from '../../src/platform/common/permissions';
import { PERMISSIONS, PermissionRegistry } from '../../src/platform/access/permissions';
import pg from 'pg';
import { parseCsv } from '../../src/platform/common/csv';
import { SUPPLIERS_PERMISSIONS } from '../../src/modules/suppliers';
import { TestApp, makeApp } from '../support/auth';
import { Client, ALL_CATALOGUE_PERMISSIONS, anonymous, buildWorld, closeCatalogue, packageBody, raceBody, slug, staffClient } from '../support/catalogue';
import { setSuppliersFlag, supplierBody } from '../support/suppliers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const RUN = `t${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
const ALL = [...ALL_CATALOGUE_PERMISSIONS, ...Object.values(SUPPLIERS_PERMISSIONS), K.customFieldRead, K.customFieldManage, K.customFieldPublish, PERMISSIONS.auditRead];
const text = (s: string) => ({ 'en-AU': s });
let n = 0;
const key = (name: string) => `${RUN}_${name}_${n++}`.slice(0, 40);

let t: TestApp;
let admin: Client;
let world: Awaited<ReturnType<typeof buildWorld>>;

beforeAll(async () => {
  t = await makeApp();
  await setSuppliersFlag(t, true);
  admin = await staffClient(t, ALL);
  world = await buildWorld(admin, { priced: false });
});
afterAll(async () => {
  // Definitions are never deleted; archive what these tests made so other test files see no custom fields.
  await t.prisma.customFieldDefinition.updateMany({ where: { key: { startsWith: RUN } }, data: { archivedAt: new Date() } });
  await t.prisma.race.updateMany({ where: { status: 'published', isDemo: false, slug: { startsWith: 'race-' } }, data: { status: 'archived' } });
  await closeCatalogue(t);
});

const ok = <T extends { status: number; body: unknown }>(r: T, what: string): T => {
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const define = async (entityType: string, name: string, type: string, extra: Record<string, unknown> = {}) =>
  ok(await admin.post('/admin/custom-fields', { entityType, key: key(name), label: text(name), type, ...extra }), `define ${name}`).body as { id: string; key: string; version: number };
const newRace = async (customFields?: Record<string, unknown>) => ok(await admin.post('/admin/catalogue/races', raceBody(customFields ? { customFields } : {})), 'create race').body;
const newPackage = async (customFields?: Record<string, unknown>, slugName = slug('pkg')) =>
  ok(await admin.post(`/admin/catalogue/editions/${world.edition.id}/packages`, packageBody({ slug: slugName, ...(customFields ? { customFields } : {}) })), 'create package').body;
const newSupplier = async (customFields?: Record<string, unknown>) => ok(await admin.post('/admin/suppliers', supplierBody(customFields ? { customFields } : {})), 'create supplier').body;
const cf = (filters: object[]) => JSON.stringify(filters);

describe('access', () => {
  it('anonymous callers are refused', async () => {
    expect([401, 403]).toContain((await anonymous(t).get('/admin/custom-fields')).status);
  });

  it('reading and managing definitions are separate permissions', async () => {
    const reader = await staffClient(t, [K.customFieldRead]);
    expect((await reader.get('/admin/custom-fields')).status).toBe(200);
    expect((await reader.post('/admin/custom-fields', { entityType: 'Race', key: key('nope'), label: text('x'), type: 'boolean' })).status).toBe(403);
    const manager = await staffClient(t, [K.customFieldManage]);
    expect((await manager.get('/admin/custom-fields')).status).toBe(403);
    const none = await staffClient(t, []);
    expect((await none.get('/admin/custom-fields')).status).toBe(403);
    const f = await define('Race', 'perm', 'boolean');
    expect((await reader.patch(`/admin/custom-fields/${f.id}`, { required: false, version: f.version })).status).toBe(403);
    expect((await reader.post(`/admin/custom-fields/${f.id}/archive`, { version: f.version })).status).toBe(403);
  });

  it('the permissions are not API key scopes', async () => {
    const defs = t.app.get(PermissionRegistry).all().filter((d) => [K.customFieldRead, K.customFieldManage].includes(d.key as never));
    expect(defs).toHaveLength(2);
    expect(defs.every((d) => d.apiKeyScopable === false)).toBe(true);
  });
});

describe('definitions', () => {
  it('create, read, update with a version, archive and restore, each audited', async () => {
    const created = await define('Race', 'colour', 'text', { validation: { maxLength: 20 } });
    expect(created).toMatchObject({ entityType: 'Race', type: 'text', required: false, visibleToCustomer: false, version: 0, archivedAt: null });
    const upd = ok(await admin.patch(`/admin/custom-fields/${created.id}`, { label: text('Colour of the bib'), required: false, displayOrder: 3, version: 0 }), 'update').body;
    expect(upd).toMatchObject({ label: text('Colour of the bib'), displayOrder: 3, version: 1 });
    expect((await admin.patch(`/admin/custom-fields/${created.id}`, { displayOrder: 4, version: 0 })).status).toBe(409);
    const arch = ok(await admin.post(`/admin/custom-fields/${created.id}/archive`, { version: 1 }), 'archive').body;
    expect(arch.archivedAt).not.toBeNull();
    expect((await admin.post(`/admin/custom-fields/${created.id}/archive`, { version: 2 })).status).toBe(409);
    const listed = (await admin.get('/admin/custom-fields?entityType=Race')).body.items.map((i: { key: string }) => i.key);
    expect(listed).not.toContain(created.key);
    expect((await admin.get('/admin/custom-fields?entityType=Race&includeArchived=true')).body.items.map((i: { key: string }) => i.key)).toContain(created.key);
    const back = ok(await admin.post(`/admin/custom-fields/${created.id}/restore`, { version: 2 }), 'restore').body;
    expect(back.archivedAt).toBeNull();
    expect((await admin.post(`/admin/custom-fields/${created.id}/restore`, { version: 3 })).status).toBe(409);
    const actions = (await t.prisma.auditLog.findMany({ where: { entityType: 'CustomFieldDefinition', entityId: created.id }, orderBy: { occurredAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['common.custom_field.created', 'common.custom_field.updated', 'common.custom_field.archived', 'common.custom_field.restored']);
  });

  it('a second field with the same key on the same record type is a 409, on another type it is fine', async () => {
    const f = await define('Race', 'dup', 'text');
    expect((await admin.post('/admin/custom-fields', { entityType: 'Race', key: f.key, label: text('x'), type: 'text' })).status).toBe(409);
    expect((await admin.post('/admin/custom-fields', { entityType: 'Package', key: f.key, label: text('x'), type: 'text' })).status).toBe(201);
  });

  it('key, type and entity cannot change: the API has no way to, and the database refuses too', async () => {
    const f = await define('Race', 'fixed', 'text');
    for (const bad of [{ key: key('other') }, { type: 'number' }, { entityType: 'Package' }]) {
      expect((await admin.patch(`/admin/custom-fields/${f.id}`, { ...bad, version: 0 })).status).toBe(422);
    }
    await expect(t.prisma.customFieldDefinition.update({ where: { id: f.id }, data: { type: 'number' } })).rejects.toThrow();
    await expect(t.prisma.customFieldDefinition.update({ where: { id: f.id }, data: { key: key('x') } })).rejects.toThrow();
    await expect(t.prisma.customFieldDefinition.update({ where: { id: f.id }, data: { entityType: 'Package' } })).rejects.toThrow();
  });

  it('there is no delete route, and the database refuses a delete', async () => {
    const f = await define('Race', 'nodelete', 'text');
    expect((await admin.delete(`/admin/custom-fields/${f.id}`)).status).toBe(404);
    await expect(t.prisma.customFieldDefinition.delete({ where: { id: f.id } })).rejects.toThrow();
    expect(await t.prisma.customFieldDefinition.count({ where: { id: f.id } })).toBe(1);
  });

  it.each([
    ['an unknown record type', { entityType: 'Customer' }],
    ['a bad key', { key: 'Bad Key' }],
    ['a select with no options', { type: 'select' }],
    ['options on a text field', { options: [{ value: 'a', label: text('A') }] }],
    ['a rule that does not fit the type', { validation: { min: 1 } }],
    ['a field that is visible to customers on a supplier', { entityType: 'Supplier', visibleToCustomer: true }],
    ['a field customers can edit on a race', { visibleToCustomer: true, editableByCustomer: true }],
    ['an unknown property', { price: 100 }],
  ])('refuses %s with 422', async (_n, over) => {
    const res = await admin.post('/admin/custom-fields', { entityType: 'Race', key: key('bad'), label: text('x'), type: 'text', ...over });
    expect(res.status).toBe(422);
  });

  it('select options can be added, relabelled and retired, but never removed', async () => {
    const f = await define('Race', 'size', 'select', { options: [{ value: 's', label: text('Small') }, { value: 'l', label: text('Large') }] });
    expect((await admin.patch(`/admin/custom-fields/${f.id}`, { options: [{ value: 's', label: text('Small') }], version: 0 })).status).toBe(422);
    const next = ok(await admin.patch(`/admin/custom-fields/${f.id}`, {
      options: [{ value: 's', label: text('Small'), retired: true }, { value: 'l', label: text('Large!') }, { value: 'm', label: text('Medium') }], version: 0,
    }), 'update options').body;
    expect(next.options.map((o: { value: string }) => o.value)).toEqual(['s', 'l', 'm']);
  });

  it('switching the customer flags follows the same rules after creation', async () => {
    const f = await define('Race', 'vis', 'text', { visibleToCustomer: true });
    expect((await admin.patch(`/admin/custom-fields/${f.id}`, { editableByCustomer: true, version: 0 })).status).toBe(422);
    const s = await define('Supplier', 'suppvis', 'text');
    expect((await admin.patch(`/admin/custom-fields/${s.id}`, { visibleToCustomer: true, version: 0 })).status).toBe(422);
  });
});

describe('making a field visible to customers', () => {
  const staleStepUp = (userId: string) => t.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });

  it('needs its own permission and a recent authenticator check; hiding it again and creating one do not', async () => {
    const manager = await staffClient(t, [K.customFieldRead, K.customFieldManage]);
    const hidden = await define('Race', 'pub', 'text');
    const race = await newRace({ [hidden.key]: 'written while internal' });
    const blocked = await manager.patch(`/admin/custom-fields/${hidden.id}`, { visibleToCustomer: true, version: 0 });
    expect(blocked.status).toBe(403);
    expect((await admin.get(`/admin/custom-fields/${hidden.id}/usage`)).status).toBe(200);
    const stillHidden = (await admin.get('/admin/custom-fields').query({ entityType: 'Race' })).body.items.find((d: { id: string }) => d.id === hidden.id);
    expect(stillHidden.visibleToCustomer).toBe(false);

    const publisher = await staffClient(t, [K.customFieldRead, K.customFieldManage, K.customFieldPublish]);
    await staleStepUp(publisher.staff.id);
    const old = await publisher.patch(`/admin/custom-fields/${hidden.id}`, { visibleToCustomer: true, version: 0 });
    expect([old.status, old.body.code]).toEqual([403, 'step_up_required']);
    const fresh = await staffClient(t, [K.customFieldRead, K.customFieldManage, K.customFieldPublish]);
    const on = ok(await fresh.patch(`/admin/custom-fields/${hidden.id}`, { visibleToCustomer: true, version: 0 }), 'publish');
    expect(on.body.visibleToCustomer).toBe(true);
    expect(race.customFields).toEqual({ [hidden.key]: 'written while internal' });

    // Turning it off, or editing a field that is already visible, needs only manage; so does creating a visible one.
    const off = ok(await manager.patch(`/admin/custom-fields/${hidden.id}`, { visibleToCustomer: false, version: 1 }), 'hide');
    expect(off.body.visibleToCustomer).toBe(false);
    ok(await manager.post('/admin/custom-fields', { entityType: 'Race', key: key('newvis'), label: text('New'), type: 'text', visibleToCustomer: true }), 'create visible');
    const again = ok(await fresh.patch(`/admin/custom-fields/${hidden.id}`, { visibleToCustomer: true, version: 2 }), 'publish again');
    ok(await manager.patch(`/admin/custom-fields/${hidden.id}`, { visibleToCustomer: true, required: false, version: again.body.version }), 'already visible, no check');
  });

  it('bringing back an archived field that is visible needs the same permission', async () => {
    const manager = await staffClient(t, [K.customFieldRead, K.customFieldManage]);
    const f = await define('Race', 'back', 'text', { visibleToCustomer: true });
    const archived = ok(await manager.post(`/admin/custom-fields/${f.id}/archive`, { version: 0 }), 'archive').body;
    const blocked = await manager.post(`/admin/custom-fields/${f.id}/restore`, { version: archived.version });
    expect(blocked.status).toBe(403);
    ok(await admin.post(`/admin/custom-fields/${f.id}/restore`, { version: archived.version }), 'restore');
    const h = await define('Race', 'backhid', 'text');
    const a2 = ok(await manager.post(`/admin/custom-fields/${h.id}/archive`, { version: 0 }), 'archive hidden').body;
    ok(await manager.post(`/admin/custom-fields/${h.id}/restore`, { version: a2.version }), 'restore hidden needs only manage');
  });

  it('the permission is never an API key scope and asks for step-up', () => {
    const def = t.app.get(PermissionRegistry).all().find((d) => d.key === K.customFieldPublish);
    expect(def).toMatchObject({ requiresStepUp: true });
    expect(def?.apiKeyScopable).not.toBe(true);
  });

  it('usage counts the records holding a value, never the values, and needs the read permission', async () => {
    const f = await define('Race', 'use', 'text');
    const none = ok(await admin.get(`/admin/custom-fields/${f.id}/usage`), 'usage').body;
    expect(none).toEqual({ records: 0 });
    await newRace({ [f.key]: 'one secret' });
    await newRace({ [f.key]: 'two secret' });
    await newRace();
    const two = ok(await admin.get(`/admin/custom-fields/${f.id}/usage`), 'usage').body;
    expect(two).toEqual({ records: 2 });
    expect(JSON.stringify(two)).not.toContain('secret');
    const nobody = await staffClient(t, []);
    expect((await nobody.get(`/admin/custom-fields/${f.id}/usage`)).status).toBe(403);
    expect((await admin.get('/admin/custom-fields/00000000-0000-4000-8000-000000000000/usage')).status).toBe(404);
  });
});

describe('the definitions table', () => {
  const owner = () => new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });

  it('the key "constructor" is refused by the API and by the database', async () => {
    const res = await admin.post('/admin/custom-fields', { entityType: 'Race', key: 'constructor', label: text('x'), type: 'text' });
    expect([400, 422]).toContain(res.status);
    await expect(
      t.prisma.customFieldDefinition.create({ data: { entityType: 'Race', key: 'constructor', label: text('x'), type: 'text' } }),
    ).rejects.toThrow(/key_format|check constraint/i);
    ok(await admin.post('/admin/custom-fields', { entityType: 'Race', key: `${RUN}_constructor`, label: text('x'), type: 'text' }), 'a longer name is fine');
  });

  it('no DELETE and no TRUNCATE, for the app role or the owner', async () => {
    const f = await define('Race', 'keep', 'text');
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE custom_field_definitions')).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe('DELETE FROM custom_field_definitions WHERE id = $1::uuid', f.id)).rejects.toThrow();
    const db = owner();
    await db.connect();
    try {
      await expect(db.query('TRUNCATE custom_field_definitions')).rejects.toThrow(/cannot be deleted; archive it/);
      await expect(db.query('DELETE FROM custom_field_definitions WHERE id = $1', [f.id])).rejects.toThrow(/cannot be deleted; archive it/);
      const { rows } = await db.query(`SELECT t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'custom_field_definitions' AND NOT t.tgisinternal`);
      const types = rows.map((r) => Number(r.tgtype));
      expect(types.some((x) => (x & 2) && (x & 32))).toBe(true); // BEFORE TRUNCATE
      expect(types.some((x) => (x & 2) && (x & 8) && (x & 16))).toBe(true); // BEFORE UPDATE OR DELETE
    } finally {
      await db.end();
    }
    expect(await t.prisma.customFieldDefinition.count({ where: { id: f.id } })).toBe(1);
  });
});

describe('values on races, packages and suppliers', () => {
  it('every type is stored, read back and merged by key; null removes a value', async () => {
    const [txt, num, date, bool, sel, multi] = [
      await define('Race', 'txt', 'text'), await define('Race', 'num', 'number', { validation: { min: 0, max: 100, integer: true } }), await define('Race', 'dt', 'date'),
      await define('Race', 'bl', 'boolean'),
      await define('Race', 'sl', 'select', { options: [{ value: 'a', label: text('A') }, { value: 'b', label: text('B') }] }),
      await define('Race', 'ms', 'multiselect', { options: [{ value: 'x', label: text('X') }, { value: 'y', label: text('Y') }], validation: { maxItems: 2 } }),
    ];
    const race = await newRace({ [txt.key]: ' hello ', [num.key]: 42, [date.key]: '2027-03-04', [bool.key]: false, [sel.key]: 'a', [multi.key]: ['y', 'x'] });
    const got = ok(await admin.get(`/admin/catalogue/races/${race.id}`), 'get').body;
    expect(got.customFields).toEqual({ [txt.key]: 'hello', [num.key]: 42, [date.key]: '2027-03-04', [bool.key]: false, [sel.key]: 'a', [multi.key]: ['x', 'y'] });
    // A patch merges: only the named keys change.
    const upd = ok(await admin.patch(`/admin/catalogue/races/${race.id}`, { customFields: { [num.key]: 7, [sel.key]: null }, version: got.version }), 'patch').body;
    expect(upd.customFields).toEqual({ [txt.key]: 'hello', [num.key]: 7, [date.key]: '2027-03-04', [bool.key]: false, [multi.key]: ['x', 'y'] });
    // A patch without customFields leaves them alone.
    const again = ok(await admin.patch(`/admin/catalogue/races/${race.id}`, { city: 'Cairns', version: upd.version }), 'patch city').body;
    expect(again.customFields).toEqual(upd.customFields);
    // The change is in the audit trail.
    expect(await t.prisma.auditLog.count({ where: { entityType: 'Race', entityId: race.id, action: 'catalogue.race.updated' } })).toBe(2);
  });

  it('the same works on packages and suppliers', async () => {
    const pf = await define('Package', 'room_note', 'text');
    const sf = await define('Supplier', 'account', 'text');
    const pkg = await newPackage({ [pf.key]: 'Quiet floor' });
    expect(pkg.customFields).toEqual({ [pf.key]: 'Quiet floor' });
    const p2 = ok(await admin.patch(`/admin/catalogue/packages/${pkg.id}`, { customFields: { [pf.key]: 'High floor' }, version: pkg.version }), 'patch package').body;
    expect(p2.customFields).toEqual({ [pf.key]: 'High floor' });
    const sup = await newSupplier({ [sf.key]: 'ACC-1' });
    expect(sup.customFields).toEqual({ [sf.key]: 'ACC-1' });
    const s2 = ok(await admin.patch(`/admin/suppliers/${sup.id}`, { customFields: { [sf.key]: 'ACC-2' }, version: sup.version }), 'patch supplier').body;
    expect(s2.customFields).toEqual({ [sf.key]: 'ACC-2' });
    // A field of another record type is unknown here.
    expect((await admin.post('/admin/suppliers', supplierBody({ customFields: { [pf.key]: 'x' } }))).status).toBe(422);
  });

  it('a duplicated package keeps its custom field values', async () => {
    const f = await define('Package', 'dupval', 'text');
    const w = await buildWorld(admin, { priced: false, packageOver: { customFields: { [f.key]: 'Carried over' } } });
    const target = ok(await admin.post(`/admin/catalogue/races/${w.race.id}/editions`, { year: 2028, startDate: '2028-06-20', endDate: '2028-06-20', dateStatus: 'confirmed' }), 'edition').body;
    const copy = ok(await admin.post(`/admin/catalogue/packages/${w.pkg.id}/duplicate`, { targetEditionId: target.id, slug: slug('copy'), checkInDate: '2028-06-18', checkOutDate: '2028-06-21', balanceDueDate: '2028-04-18' }), 'duplicate').body;
    expect(copy.customFields).toEqual({ [f.key]: 'Carried over' });
  });

  it.each([
    ['an unknown key', () => ({ nope_not_a_field: 'x' })],
    ['a value of the wrong type', async () => ({ [(await define('Race', 'wt', 'number')).key]: 'seven' })],
    ['a number out of range', async () => ({ [(await define('Race', 'rng', 'number', { validation: { max: 5 } })).key]: 6 })],
    ['an unknown option', async () => ({ [(await define('Race', 'uo', 'select', { options: [{ value: 'a', label: text('A') }] })).key]: 'zz' })],
    ['text over its limit', async () => ({ [(await define('Race', 'tl', 'text', { validation: { maxLength: 3 } })).key]: 'abcd' })],
    ['a date outside its range', async () => ({ [(await define('Race', 'dr', 'date', { validation: { minDate: '2027-01-01' } })).key]: '2026-12-31' })],
  ])('refuses %s with 422 and does not write', async (_n, build) => {
    const body = await build();
    const before = await t.prisma.race.count();
    const res = await admin.post('/admin/catalogue/races', raceBody({ customFields: body }));
    expect(res.status).toBe(422);
    expect(await t.prisma.race.count()).toBe(before);
    const sent = Object.values(body)[0];
    // The message names the field key at most, never the value that was sent.
    if (typeof sent === 'string' && sent.length > 2) expect(JSON.stringify(res.body)).not.toContain(sent);
  });

  it('an archived field is unknown to new writes, its stored value survives, and restoring brings it back', async () => {
    const f = await define('Race', 'arch', 'text');
    const race = await newRace({ [f.key]: 'kept' });
    ok(await admin.post(`/admin/custom-fields/${f.id}/archive`, { version: 0 }), 'archive');
    const r2 = await admin.patch(`/admin/catalogue/races/${race.id}`, { customFields: { [f.key]: 'changed' }, version: race.version });
    expect(r2.status).toBe(422);
    const other = await define('Race', 'other', 'text');
    const r3 = ok(await admin.patch(`/admin/catalogue/races/${race.id}`, { customFields: { [other.key]: 'y' }, version: race.version }), 'patch other').body;
    expect(r3.customFields).toEqual({ [f.key]: 'kept', [other.key]: 'y' });
    ok(await admin.post(`/admin/custom-fields/${f.id}/restore`, { version: 1 }), 'restore');
    const r4 = ok(await admin.patch(`/admin/catalogue/races/${race.id}`, { customFields: { [f.key]: 'edited' }, version: r3.version }), 'patch restored').body;
    expect(r4.customFields[f.key]).toBe('edited');
  });

  it('required: enforced on create and when clearing, not on old records that predate the field', async () => {
    const old = await newRace();
    const f = await define('Race', 'req', 'text', { required: true });
    try {
      expect((await admin.post('/admin/catalogue/races', raceBody())).status).toBe(422);
      expect((await admin.post('/admin/catalogue/races', raceBody({ customFields: { [f.key]: '   ' } }))).status).toBe(422);
      const made = await newRace({ [f.key]: 'present' });
      expect((await admin.patch(`/admin/catalogue/races/${made.id}`, { customFields: { [f.key]: null }, version: made.version })).status).toBe(422);
      // An older record can still be edited without touching the field.
      expect((await admin.patch(`/admin/catalogue/races/${old.id}`, { city: 'Perth', version: old.version })).status).toBe(200);
    } finally {
      ok(await admin.post(`/admin/custom-fields/${f.id}/archive`, { version: 0 }), 'archive required field');
    }
  });

  it('a retired option stays valid on the record that holds it only', async () => {
    const f = await define('Race', 'ret', 'select', { options: [{ value: 'a', label: text('A') }, { value: 'b', label: text('B') }] });
    const holder = await newRace({ [f.key]: 'a' });
    ok(await admin.patch(`/admin/custom-fields/${f.id}`, { options: [{ value: 'a', label: text('A'), retired: true }, { value: 'b', label: text('B') }], version: 0 }), 'retire');
    expect((await admin.post('/admin/catalogue/races', raceBody({ customFields: { [f.key]: 'a' } }))).status).toBe(422);
    expect((await admin.patch(`/admin/catalogue/races/${holder.id}`, { customFields: { [f.key]: 'a' }, version: holder.version })).status).toBe(200);
  });

  it('writing values needs the record permission, not the definition permissions', async () => {
    const f = await define('Race', 'perm2', 'text');
    const editor = await staffClient(t, ALL_CATALOGUE_PERMISSIONS);
    const res = await editor.post('/admin/catalogue/races', raceBody({ customFields: { [f.key]: 'by an editor' } }));
    expect(res.status).toBe(201);
    const reader = await staffClient(t, [K.customFieldRead]);
    expect((await reader.post('/admin/catalogue/races', raceBody({ customFields: { [f.key]: 'x' } }))).status).toBe(403);
  });
});

describe('filters', () => {
  it('text, number, date, boolean, select and multiselect filters on the race list', async () => {
    const txt = await define('Race', 'ftxt', 'text');
    const num = await define('Race', 'fnum', 'number');
    const dt = await define('Race', 'fdt', 'date');
    const bl = await define('Race', 'fbl', 'boolean');
    const sl = await define('Race', 'fsl', 'select', { options: [{ value: 'a', label: text('A') }, { value: 'b', label: text('B') }] });
    const ms = await define('Race', 'fms', 'multiselect', { options: [{ value: 'x', label: text('X') }, { value: 'y', label: text('Y') }] });
    const r1 = await newRace({ [txt.key]: 'Sunrise Start', [num.key]: 10, [dt.key]: '2027-01-10', [bl.key]: true, [sl.key]: 'a', [ms.key]: ['x'] });
    const r2 = await newRace({ [txt.key]: 'Night run', [num.key]: 20, [dt.key]: '2027-06-10', [bl.key]: false, [sl.key]: 'b', [ms.key]: ['x', 'y'] });
    const r3 = await newRace();
    const ids = async (filters: object[]) => {
      const res = ok(await admin.get('/admin/catalogue/races').query({ cf: cf(filters), pageSize: 50 }), 'list').body;
      return (res.items as Array<{ id: string }>).map((i) => i.id).sort();
    };
    const only = (...rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
    expect(await ids([{ key: txt.key, op: 'contains', value: 'sunrise' }])).toEqual(only(r1));
    expect(await ids([{ key: txt.key, op: 'eq', value: 'Night run' }])).toEqual(only(r2));
    expect(await ids([{ key: num.key, op: 'gte', value: 10 }])).toEqual(only(r1, r2));
    expect(await ids([{ key: num.key, op: 'gt', value: 10 }])).toEqual(only(r2));
    expect(await ids([{ key: num.key, op: 'lt', value: 20 }])).toEqual(only(r1));
    expect(await ids([{ key: dt.key, op: 'gt', value: '2027-03-01' }])).toEqual(only(r2));
    expect(await ids([{ key: dt.key, op: 'lte', value: '2027-03-01' }])).toEqual(only(r1));
    expect(await ids([{ key: dt.key, op: 'eq', value: '2027-06-10' }])).toEqual(only(r2));
    expect(await ids([{ key: bl.key, op: 'eq', value: true }])).toEqual(only(r1));
    expect(await ids([{ key: bl.key, op: 'eq', value: false }])).toEqual(only(r2));
    expect(await ids([{ key: sl.key, op: 'eq', value: 'b' }])).toEqual(only(r2));
    expect(await ids([{ key: sl.key, op: 'in', value: ['a', 'b'] }])).toEqual(only(r1, r2));
    expect(await ids([{ key: ms.key, op: 'has', value: 'y' }])).toEqual(only(r2));
    expect(await ids([{ key: ms.key, op: 'has', value: 'x' }])).toEqual(only(r1, r2));
    // Filters combine with AND, with the other list filters, and never match a record without a value.
    expect(await ids([{ key: ms.key, op: 'has', value: 'x' }, { key: num.key, op: 'gt', value: 10 }])).toEqual(only(r2));
    expect(await ids([{ key: num.key, op: 'gte', value: 0 }])).not.toContain(r3.id);
    expect(ok(await admin.get('/admin/catalogue/races').query({ cf: cf([{ key: sl.key, op: 'eq', value: 'a' }]), q: 'zzz-nothing-matches' }), 'list').body.items).toEqual([]);
  });

  it('packages and suppliers can be filtered too', async () => {
    const pf = await define('Package', 'pf', 'number');
    const sf = await define('Supplier', 'sf', 'text');
    const p1 = await newPackage({ [pf.key]: 5 });
    await newPackage({ [pf.key]: 50 });
    const pl = ok(await admin.get('/admin/catalogue/packages').query({ cf: cf([{ key: pf.key, op: 'lt', value: 10 }]), editionId: world.edition.id }), 'packages').body;
    expect(pl.items.map((i: { id: string }) => i.id)).toEqual([p1.id]);
    const s1 = await newSupplier({ [sf.key]: 'Harbour account' });
    await newSupplier({ [sf.key]: 'Other' });
    const sl = ok(await admin.get('/admin/suppliers').query({ cf: cf([{ key: sf.key, op: 'contains', value: 'harbour' }]) }), 'suppliers').body;
    expect(sl.items.map((i: { id: string }) => i.id)).toEqual([s1.id]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['an unknown field', JSON.stringify([{ key: 'no_such_field', op: 'eq', value: 'x' }])],
    ['more than five filters', JSON.stringify(Array(6).fill({ key: 'a', op: 'eq', value: 'x' }))],
    ['an operator the type does not take', 'type'],
  ])('answers 422 for %s', async (_n, raw) => {
    let param = raw;
    if (raw === 'type') {
      const f = await define('Race', 'optype', 'boolean');
      param = JSON.stringify([{ key: f.key, op: 'gt', value: true }]);
    }
    expect((await admin.get('/admin/catalogue/races').query({ cf: param })).status).toBe(422);
  });

  it('an archived field cannot be filtered on', async () => {
    const f = await define('Race', 'farch', 'text');
    ok(await admin.post(`/admin/custom-fields/${f.id}/archive`, { version: 0 }), 'archive');
    expect((await admin.get('/admin/catalogue/races').query({ cf: cf([{ key: f.key, op: 'eq', value: 'x' }]) })).status).toBe(422);
  });

  it('a filter value is bound as a parameter, not run as SQL', async () => {
    const f = await define('Race', 'inj', 'text');
    const res = await admin.get('/admin/catalogue/races').query({ cf: cf([{ key: f.key, op: 'contains', value: "x'); DROP TABLE races;--" }]) });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(await t.prisma.race.count()).toBeGreaterThan(0);
  });
});

describe('CSV', () => {
  const csvOf = (res: { text: string; body: unknown }) => (res.text ?? '') as string;
  const rowsOf = (csv: string) => parseCsv(csv);
  /** A file as a person would send it back: the cells exactly as exported, only quoted. No guard is applied again. */
  const rawCsv = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');

  it('export has a cf:<key> column per active field, and import reads them back', async () => {
    const num = await define('Race', 'cnum', 'number');
    const ms = await define('Race', 'cms', 'multiselect', { options: [{ value: 'x', label: text('X') }, { value: 'y', label: text('Y') }] });
    const txt = await define('Race', 'ctxt', 'text');
    const race = await newRace({ [num.key]: 12.5, [ms.key]: ['x', 'y'], [txt.key]: '=cmd()' });
    const exp = ok(await admin.post('/admin/catalogue/races/export', {}), 'export');
    const rows = rowsOf(csvOf(exp));
    const header = rows[0]!;
    for (const f of [num, ms, txt]) expect(header).toContain(`cf:${f.key}`);
    const mine = rows.find((r) => r[0] === race.slug)!;
    expect(mine[header.indexOf(`cf:${num.key}`)]).toBe('12.5');
    expect(mine[header.indexOf(`cf:${ms.key}`)]).toBe('x; y');
    // Formula text is guarded in the file (task 0.5), and an exported file imports again.
    expect(mine[header.indexOf(`cf:${txt.key}`)]).toBe("'=cmd()");
    const base = ['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'summary'];
    const newSlug = slug('csv');
    const csv = [[...base, `cf:${num.key}`, `cf:${ms.key}`, `cf:${txt.key}`].join(','), [newSlug, 'Imported Run', 'AU', 'Perth', 'Australia/Perth', 'road', 'A summary', '3', 'y', "'=cmd()"].join(',')].join('\r\n');
    const check = ok(await admin.post('/admin/catalogue/races/import', { csv, dryRun: true }), 'dry run').body;
    expect(check).toMatchObject({ valid: true, committed: false });
    const done = ok(await admin.post('/admin/catalogue/races/import', { csv, dryRun: false }), 'import').body;
    expect(done.committed).toBe(true);
    const created = await t.prisma.race.findUniqueOrThrow({ where: { slug: newSlug } });
    expect(created.customFields).toEqual({ [num.key]: 3, [ms.key]: ['y'], [txt.key]: '=cmd()' });
  });

  it.each([
    ['a formula that opens a link', '=HYPERLINK("http://example.test/x","click")', true],
    ['a plus formula', '+1+1', true],
    ['a minus formula', '-2+3', true],
    ['an at formula', '@SUM(A1:A2)', true],
    ['text that already starts with a quote', "'=already quoted", false],
    ['text with a comma, a quote and a line break', 'a, "b"\nc', false],
    ['plain text', 'Meet at the start line', false],
  ])('text cell: %s leaves the file guarded and comes back unchanged', async (_n, value, guarded) => {
    const f = await define('Race', 'inject', 'text');
    const race = await newRace({ [f.key]: value });
    const exp = parseCsv(csvOf(ok(await admin.post('/admin/catalogue/races/export', {}), 'export')));
    const header = exp[0]!;
    const row = exp.find((r) => r[0] === race.slug)!;
    const written = row[header.indexOf(`cf:${f.key}`)]!;
    if (guarded) expect(written).toBe(`'${value}`);
    expect(/^[=+\-@]/.test(written)).toBe(false);
    const col = (name: string) => row[header.indexOf(name)]!;
    const newSlug = slug('inj');
    const back = rawCsv([['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'summary', `cf:${f.key}`], [newSlug, col('name'), col('countryCode'), col('city'), col('timeZone'), col('raceType'), col('summary'), written]]);
    expect(ok(await admin.post('/admin/catalogue/races/import', { csv: back, dryRun: false }), 'import').body.committed).toBe(true);
    const imported = await t.prisma.race.findUniqueOrThrow({ where: { slug: newSlug } });
    expect(imported.customFields).toEqual({ [f.key]: value });
  });

  it.each([[1e-7], [-1e-7], [1.5e-10], [123456789012], [0.1 + 0.2]])('number %s exports without an exponent and imports as the same number', async (value) => {
    const f = await define('Race', 'tiny', 'number');
    const race = await newRace({ [f.key]: value });
    const exp = parseCsv(csvOf(ok(await admin.post('/admin/catalogue/races/export', {}), 'export')));
    const header = exp[0]!;
    const row = exp.find((r) => r[0] === race.slug)!;
    const written = row[header.indexOf(`cf:${f.key}`)]!;
    expect(written).not.toMatch(/e/i);
    expect(Number(written)).toBe(value);
    const col = (name: string) => row[header.indexOf(name)]!;
    const newSlug = slug('num');
    const back = rawCsv([['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'summary', `cf:${f.key}`], [newSlug, col('name'), col('countryCode'), col('city'), col('timeZone'), col('raceType'), col('summary'), written]]);
    ok(await admin.post('/admin/catalogue/races/import', { csv: back, dryRun: false }), 'import');
    expect((await t.prisma.race.findUniqueOrThrow({ where: { slug: newSlug } })).customFields).toEqual({ [f.key]: value });
  });

  it('a bad custom cell writes nothing and the error has the column and a code but no value', async () => {
    const num = await define('Race', 'bad', 'number', { validation: { max: 10 } });
    const base = ['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'summary'];
    const s1 = slug('good');
    const s2 = slug('bad');
    const row = (s: string, v: string) => [s, 'Run', 'AU', 'Perth', 'Australia/Perth', 'road', 'Sum', v].join(',');
    const csv = [[...base, `cf:${num.key}`].join(','), row(s1, '4'), row(s2, '99999')].join('\r\n');
    const res = ok(await admin.post('/admin/catalogue/races/import', { csv, dryRun: false }), 'import').body;
    expect(res).toMatchObject({ valid: false, committed: false });
    expect(res.errors).toEqual([{ row: 2, column: `cf:${num.key}`, code: 'custom_field_above_maximum' }]);
    expect(JSON.stringify(res)).not.toContain('99999');
    expect(await t.prisma.race.count({ where: { slug: { in: [s1, s2] } } })).toBe(0);
  });

  it('an archived field has no column, and a column for an unknown field is rejected', async () => {
    const f = await define('Race', 'carch', 'text');
    ok(await admin.post(`/admin/custom-fields/${f.id}/archive`, { version: 0 }), 'archive');
    expect(rowsOf(csvOf(ok(await admin.post('/admin/catalogue/races/export', {}), 'export')))[0]).not.toContain(`cf:${f.key}`);
    const base = ['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'summary'];
    const csv = [[...base, `cf:${f.key}`].join(','), [slug('x'), 'Run', 'AU', 'Perth', 'Australia/Perth', 'road', 'Sum', 'v'].join(',')].join('\r\n');
    const res = ok(await admin.post('/admin/catalogue/races/import', { csv, dryRun: true }), 'import').body;
    expect(res.errors).toEqual([{ row: 0, column: `cf:${f.key}`, code: 'unknown_column' }]);
  });

  it('a required field must have a column and a value in an import', async () => {
    const f = await define('Race', 'creq', 'text', { required: true });
    try {
      const base = ['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'summary'];
      const line = (extra: string[]) => [slug('r'), 'Run', 'AU', 'Perth', 'Australia/Perth', 'road', 'Sum', ...extra].join(',');
      const missing = ok(await admin.post('/admin/catalogue/races/import', { csv: [base.join(','), line([])].join('\r\n'), dryRun: true }), 'import').body;
      expect(missing.errors).toContainEqual({ row: 0, column: `cf:${f.key}`, code: 'missing_column' });
      const blank = ok(await admin.post('/admin/catalogue/races/import', { csv: [[...base, `cf:${f.key}`].join(','), line([''])].join('\r\n'), dryRun: true }), 'import').body;
      expect(blank.errors).toContainEqual({ row: 1, column: `cf:${f.key}`, code: 'required' });
    } finally {
      ok(await admin.post(`/admin/custom-fields/${f.id}/archive`, { version: 0 }), 'archive');
    }
  });

  it('package export and import carry custom fields too', async () => {
    const f = await define('Package', 'pcsv', 'boolean');
    const pkg = await newPackage({ [f.key]: true });
    const exp = rowsOf(csvOf(ok(await admin.post(`/admin/catalogue/editions/${world.edition.id}/packages/export`, {}), 'export')));
    expect(exp[0]).toContain(`cf:${f.key}`);
    expect(exp.find((r) => r[0] === pkg.slug)![exp[0]!.indexOf(`cf:${f.key}`)]).toBe('true');
    const s = slug('pk');
    const csv = [`slug,name,checkInDate,checkOutDate,balanceDueDate,maxTravellers,cf:${f.key}`, `${s},Weekend,2027-06-18,2027-06-21,2027-04-18,4,false`].join('\r\n');
    ok(await admin.post(`/admin/catalogue/editions/${world.edition.id}/packages/import`, { csv, dryRun: false }), 'import');
    expect((await t.prisma.package.findFirstOrThrow({ where: { slug: s } })).customFields).toEqual({ [f.key]: false });
  });
});

describe('what customers can see', () => {
  it('the public race and package views carry only active fields marked visible, with a value', async () => {
    const shown = await define('Race', 'shown', 'text', { visibleToCustomer: true, displayOrder: 1 });
    const hidden = await define('Race', 'hidden', 'text');
    const choice = await define('Race', 'choice', 'select', { visibleToCustomer: true, displayOrder: 2, options: [{ value: 'a', label: text('Option A') }, { value: 'b', label: text('Option B') }] });
    const archived = await define('Race', 'gone', 'text', { visibleToCustomer: true });
    const pshown = await define('Package', 'pshown', 'text', { visibleToCustomer: true });
    const phidden = await define('Package', 'phidden', 'text');
    const w = await buildWorld(admin, { priced: false, packageOver: { customFields: { [pshown.key]: 'Late check-out', [phidden.key]: 'internal note' } } });
    const race = ok(await admin.get(`/admin/catalogue/races/${w.race.id}`), 'race').body;
    ok(await admin.patch(`/admin/catalogue/races/${w.race.id}`, { customFields: { [shown.key]: 'Start at dawn', [hidden.key]: 'secret', [choice.key]: 'b', [archived.key]: 'old' }, version: race.version }), 'set');
    ok(await admin.post(`/admin/custom-fields/${archived.id}/archive`, { version: 0 }), 'archive');
    const fresh = ok(await admin.get(`/admin/catalogue/races/${w.race.id}`), 'race').body;
    ok(await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: fresh.version }), 'publish');
    const ed = ok(await admin.get(`/admin/catalogue/editions/${w.edition.id}`), 'edition').body;
    ok(await admin.post(`/admin/catalogue/editions/${w.edition.id}/status`, { status: 'announced', version: ed.version }), 'announce');
    const pub = ok(await anonymous(t).get(`/catalogue/races/${w.race.slug}`), 'public race').body;
    expect(pub.customFields).toEqual([
      { key: shown.key, label: text('shown'), type: 'text', value: 'Start at dawn' },
      { key: choice.key, label: text('choice'), type: 'select', value: 'b', options: [{ value: 'b', label: text('Option B') }] },
    ]);
    const body = JSON.stringify(pub);
    for (const secret of ['secret', 'old', 'internal note']) expect(body).not.toContain(secret);
    ok(await admin.post(`/admin/catalogue/packages/${w.pkg.id}/sale-status`, { status: 'coming_soon', version: w.pkg.version }), 'announce package');
    const pubPkg = ok(await anonymous(t).get(`/catalogue/races/${w.race.slug}/editions/${w.edition.year}/packages/${w.pkg.slug}`), 'public package');
    expect(pubPkg.body.customFields).toEqual([{ key: pshown.key, label: text('pshown'), type: 'text', value: 'Late check-out' }]);
    expect(JSON.stringify(pubPkg.body)).not.toContain('internal note');
    // The panel preview uses the same builder.
    const preview = ok(await admin.get(`/admin/catalogue/packages/${w.pkg.id}/preview`), 'preview').body;
    expect(preview.customFields).toEqual([{ key: pshown.key, label: text('pshown'), type: 'text', value: 'Late check-out' }]);
  });

  it('supplier fields are never customer visible', async () => {
    const f = await define('Supplier', 'priv', 'text');
    const s = await newSupplier({ [f.key]: 'bank detail' });
    expect(s.customFields).toEqual({ [f.key]: 'bank detail' });
    const rows = await t.prisma.customFieldDefinition.findMany({ where: { entityType: 'Supplier', key: { startsWith: RUN } } });
    expect(rows.every((r) => !r.visibleToCustomer && !r.editableByCustomer)).toBe(true);
  });
});
