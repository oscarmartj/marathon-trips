import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv, unguardCell } from '../../src/platform/common/csv';
import { COMMON_PERMISSIONS_KEYS as K } from '../../src/platform/common/permissions';
import { PERMISSIONS } from '../../src/platform/access/permissions';
import { STATE_HEADERS, StaffFixture, TestApp, createStaff, makeApp, signInStaff } from '../support/auth';

const RUN = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const TASK_PERMS = [K.tableUse, K.taskRead, K.taskWrite, K.taskDelete, K.taskExport, K.taskImport, K.tagManage, K.viewManage, PERMISSIONS.auditRead];

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  const ids = (await t.prisma.task.findMany({ where: { title: { contains: RUN } }, select: { id: true } })).map((x) => x.id);
  await t.prisma.note.deleteMany({ where: { entityId: { in: ids } } });
  await t.prisma.tagging.deleteMany({ where: { entityId: { in: ids } } });
  await t.prisma.tag.deleteMany({ where: { name: { startsWith: RUN } } });
  await t.prisma.searchDocument.deleteMany({ where: { entityId: { in: ids } } });
  await t.prisma.task.deleteMany({ where: { id: { in: ids } } });
  await t.prisma.savedView.deleteMany({ where: { name: { startsWith: RUN } } });
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'common.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'common.%'`);
  await t.close();
});

const as = async (s: StaffFixture) => {
  const cookie = await signInStaff(t, s);
  return {
    id: s.id,
    get: (path: string, query: Record<string, string> = {}) => t.http().get(path).query(query).set('Cookie', cookie),
    post: (path: string, body: object = {}) => t.http().post(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
    patch: (path: string, body: object) => t.http().patch(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
    put: (path: string, body: object) => t.http().put(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
    del: (path: string) => t.http().delete(path).set(STATE_HEADERS).set('Cookie', cookie),
  };
};
type Client = Awaited<ReturnType<typeof as>>;

let n = 0;
const title = (label: string) => `${RUN} ${label}`;
async function mk(c: Client, label: string, extra: object = {}): Promise<string> {
  const r = await c.post('/admin/tasks', { title: title(`${label}${n++}`), ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
const rows = (c: Client, q: Record<string, string> = {}) => c.get('/admin/tables/Task/rows', { q: RUN, ...q });
const titles = (r: { body: { rows: Array<{ title: string }> } }) => r.body.rows.map((x) => x.title.replace(`${RUN} `, ''));

describe('list, filters, sort and pagination', () => {
  it('combined_filters_sort_and_pagination_over_tasks', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const a = await mk(c, 'alpha', { dueAt: '2026-01-10' });
    await mk(c, 'bravo', { dueAt: '2026-03-10' });
    await mk(c, 'charlie');
    await mk(c, 'delta', { dueAt: '2026-05-10' });
    await mk(c, 'echo', { dueAt: '2026-07-10' });
    await c.patch(`/admin/tasks/${a}`, { version: 0, status: 'done' });

    const all = await rows(c, { sort: 'title:desc', pageSize: '2', page: '2' });
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(5);
    expect(titles(all).map((x) => x.replace(/\d+$/, ''))).toEqual(['charlie', 'bravo']);

    const f = (filters: object[], extra: Record<string, string> = {}) => rows(c, { filters: JSON.stringify(filters), ...extra });
    expect(titles(await f([{ field: 'status', op: 'eq', value: 'open' }, { field: 'dueAt', op: 'gte', value: '2026-03-01' }], { sort: 'dueAt:asc' })).map((x) => x.replace(/\d+$/, ''))).toEqual(['bravo', 'delta', 'echo']);
    expect((await f([{ field: 'dueAt', op: 'empty' }])).body.total).toBe(1);
    expect((await f([{ field: 'title', op: 'contains', value: 'LPH' }])).body.total).toBe(1);
    expect((await f([{ field: 'status', op: 'in', value: ['done', 'cancelled'] }])).body.total).toBe(1);
    expect((await rows(c, { sort: 'dueAt:asc' })).body.rows.at(-1).dueAt).toBeNull();
  });

  it.each([
    ['unknown_field', { filters: JSON.stringify([{ field: 'passwordHash', op: 'eq', value: 'x' }]) }],
    ['operator_not_for_type', { filters: JSON.stringify([{ field: 'dueAt', op: 'contains', value: 'x' }]) }],
    ['sort_on_unlisted_column', { sort: 'id:asc,secret:asc' }],
    ['page_size_over_limit', { pageSize: '1000' }],
    ['bad_filters_json', { filters: '{not json' }],
    ['unknown_query_parameter', { sql: '1' }],
  ])('rejects_%s_with_422', async (_n, q) => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    expect((await rows(c, q)).status).toBe(422);
  });
});

describe('permissions', () => {
  it('role_without_the_table_permission_gets_403_and_unknown_tables_are_404', async () => {
    const onlyBase = await as(await createStaff(t, { permissions: [K.tableUse] }));
    expect((await rows(onlyBase)).status).toBe(403);
    expect((await onlyBase.get('/admin/tables/Task/meta')).status).toBe(403);
    expect((await onlyBase.get('/admin/tables/Nope/meta')).status).toBe(404);
    const none = await as(await createStaff(t, { permissions: [K.taskRead] }));
    expect((await rows(none)).status).toBe(403); // the baseline mark is missing
  });

  it('meta_lists_what_the_caller_can_do', async () => {
    const reader = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead] }));
    const meta = (await reader.get('/admin/tables/Task/meta')).body;
    expect(meta.can).toEqual({ write: false, delete: false, export: false, import: false, annotate: false });
    expect(meta.columns.map((x: { key: string }) => x.key)).toContain('dueAt');
    expect(meta.bulkActions).toEqual(['complete', 'cancel', 'reopen', 'delete', 'restore']);
  });

  it('showing_deleted_records_needs_the_delete_permission', async () => {
    const reader = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead] }));
    expect((await rows(reader, { deleted: 'only' })).status).toBe(403);
  });
});

describe('global search', () => {
  it('finds_by_title_prefix_follows_delete_and_restore_and_respects_permissions', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const word = `zz${RUN}`;
    const id = await mk(c, `${word} quokka`);
    const hits = async (q: string, who: Client = c) => (await who.get('/admin/search', { q })).body as Array<{ entityId: string; entityType: string }>;
    expect((await hits(`${word} quok`)).map((h) => h.entityId)).toEqual([id]);
    expect((await hits(`${word} quok`))[0]!.entityType).toBe('Task');
    await c.patch(`/admin/tasks/${id}`, { version: 0, title: `${RUN} renamed ${word}wombat` });
    expect(await hits(`${word}wom`)).toHaveLength(1);
    expect(await hits(`${word} quok`)).toHaveLength(0);

    const other = await as(await createStaff(t, { permissions: [K.tableUse] }));
    expect(await hits(`${word}wom`, other)).toEqual([]);

    expect((await c.post(`/admin/tables/Task/${id}/delete`, {})).status).toBe(200);
    expect(await hits(`${word}wom`)).toHaveLength(0);
    expect((await c.post(`/admin/tables/Task/${id}/restore`, {})).status).toBe(200);
    expect(await hits(`${word}wom`)).toHaveLength(1);
    expect((await c.get('/admin/search', { q: '' })).status).toBe(422);
  });

  it('reindex_rebuilds_missing_documents', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const id = await mk(c, 'reindexable');
    await t.prisma.searchDocument.deleteMany({ where: { entityId: id } });
    const { SearchIndexService } = await import('../../src/platform/common/search.service');
    const { TableAccessService } = await import('../../src/platform/common/table-access.service');
    await t.app.get(SearchIndexService).reindex(t.app.get(TableAccessService).def('Task'));
    expect(await t.prisma.searchDocument.count({ where: { entityId: id } })).toBe(1);
  });
});

describe('saved views', () => {
  it('create_apply_share_and_permissions', async () => {
    const owner = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead] }));
    const manager = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead, K.viewManage] }));
    const peer = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead] }));
    const query = { q: RUN, filters: [{ field: 'status', op: 'eq', value: 'open' }], sort: [{ field: 'title', dir: 'asc' }], tagIds: [], tagMode: 'any', deleted: 'exclude' };

    const created = await owner.post('/admin/tables/Task/views', { name: `${RUN} mine`, query, columns: ['title', 'status'] });
    expect(created.status).toBe(201);
    const list = (await owner.get('/admin/tables/Task/views')).body as Array<{ id: string; name: string; mine: boolean; query: { filters: unknown[] }; version: number }>;
    expect(list.find((v) => v.name === `${RUN} mine`)).toMatchObject({ mine: true, query: { filters: query.filters }, version: 0 });
    expect((await owner.post('/admin/tables/Task/views', { name: `${RUN} mine`, query })).status).toBe(409);

    // A stored view cannot hold a field the table does not allow.
    expect((await owner.post('/admin/tables/Task/views', { name: `${RUN} bad`, query: { ...query, filters: [{ field: 'passwordHash', op: 'eq', value: 'x' }] } })).status).toBe(422);
    expect((await owner.post('/admin/tables/Task/views', { name: `${RUN} bad2`, query, columns: ['nope'] })).status).toBe(422);

    // Private to its owner; sharing needs common.view.manage.
    expect((await peer.get('/admin/tables/Task/views')).body.some((v: { name: string }) => v.name === `${RUN} mine`)).toBe(false);
    expect((await peer.patch(`/admin/tables/Task/views/${created.body.id}`, { version: 0, name: 'x' })).status).toBe(404);
    expect((await owner.post('/admin/tables/Task/views', { name: `${RUN} shared try`, query, shared: true })).status).toBe(403);
    const shared = await manager.post('/admin/tables/Task/views', { name: `${RUN} shared`, query, shared: true });
    expect(shared.status).toBe(201);
    expect((await peer.get('/admin/tables/Task/views')).body.some((v: { name: string }) => v.name === `${RUN} shared`)).toBe(true);
    expect((await peer.del(`/admin/tables/Task/views/${shared.body.id}`)).status).toBe(403);
    expect((await manager.patch(`/admin/tables/Task/views/${shared.body.id}`, { version: 5, name: `${RUN} s2` })).status).toBe(409);
    expect((await manager.patch(`/admin/tables/Task/views/${shared.body.id}`, { version: 0, name: `${RUN} s2` })).status).toBe(200);
    expect((await manager.del(`/admin/tables/Task/views/${shared.body.id}`)).status).toBe(204);
    expect((await owner.del(`/admin/tables/Task/views/${created.body.id}`)).status).toBe(204);
    const gone = await t.prisma.auditLog.count({ where: { entityType: 'SavedView', entityId: created.body.id } });
    expect(gone).toBe(2);
  });
});

describe('bulk actions', () => {
  it('respect_the_permission_of_each_element_and_one_failure_does_not_undo_the_rest', async () => {
    const plain = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead, K.taskWrite, K.taskDelete] }));
    const a = await mk(plain, 'bulkA');
    const b = await mk(plain, 'bulkB');
    const auto = (await t.prisma.task.create({ data: { title: title('bulkAuto'), source: 'automation' } })).id;
    const done = await mk(plain, 'bulkDone');
    await plain.patch(`/admin/tasks/${done}`, { version: 0, status: 'done' });

    const res = await plain.post('/admin/tables/Task/bulk', { action: 'complete', ids: [a, auto, b, done, crypto.randomUUID()] });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body.results as Array<{ id: string; ok: boolean; code: string }>).map((r) => [r.id, r]));
    expect(byId[a]).toMatchObject({ ok: true });
    expect(byId[b]).toMatchObject({ ok: true });
    expect(byId[auto]).toMatchObject({ ok: false, code: 'forbidden' });
    expect(byId[done]).toMatchObject({ ok: false, code: 'already_in_state' });
    expect(res.body.status).toBe('partial');
    expect((await t.prisma.task.findMany({ where: { id: { in: [a, b, auto] } }, orderBy: { id: 'asc' } })).map((x) => [x.id === auto, x.status]).sort()).toEqual([[false, 'done'], [false, 'done'], [true, 'open']]);
    expect(await t.prisma.bulkOperation.findUnique({ where: { id: res.body.id } })).toMatchObject({ action: 'complete', status: 'partial', createdById: plain.id });
    expect(await t.prisma.auditLog.count({ where: { entityType: 'Task', entityId: a, action: 'common.task.updated' } })).toBe(1);

    // The single-record routes use the same rule.
    expect((await plain.patch(`/admin/tasks/${auto}`, { version: 0, title: title('changed') })).status).toBe(403);
    expect((await plain.post(`/admin/tables/Task/${auto}/delete`, {})).status).toBe(403);

    const manager = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead, K.taskWrite, K.taskManageAutomated] }));
    const ok = await manager.post('/admin/tables/Task/bulk', { action: 'complete', ids: [auto] });
    expect(ok.body).toMatchObject({ status: 'completed', results: [{ id: auto, ok: true, code: 'ok' }] });
  });

  it('refuses_unknown_actions_and_oversize_selections', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    expect((await c.post('/admin/tables/Task/bulk', { action: 'explode', ids: [crypto.randomUUID()] })).status).toBe(422);
    expect((await c.post('/admin/tables/Task/bulk', { action: 'complete', ids: Array.from({ length: 101 }, () => crypto.randomUUID()) })).status).toBe(422);
    expect((await c.post('/admin/tables/Task/bulk', { action: 'complete', ids: [] })).status).toBe(422);
    const noPerm = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead] }));
    const id = await mk(c, 'noperm');
    expect((await noPerm.post('/admin/tables/Task/bulk', { action: 'delete', ids: [id] })).body.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('csv', () => {
  it('export_guards_cells_that_begin_with_a_formula_character', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const marker = `${RUN} guard`;
    const ids: string[] = [];
    for (const x of ['=1+1', '+SUM(1)', '-2 pears', '@ref']) ids.push((await c.post('/admin/tasks', { title: x, description: marker })).body.id);
    const res = await c.post('/admin/tables/Task/export', { query: { q: marker, filters: [], sort: [{ field: 'title', dir: 'asc' }] } });
    const table = parseCsv(res.text);
    const cells = table.slice(1).map((r) => r[0]!).sort(); // row order depends on the database collation
    expect(cells).toEqual(["'+SUM(1)", "'-2 pears", "'=1+1", "'@ref"]);
    expect(cells.map((x) => unguardCell(x)).sort()).toEqual(['+SUM(1)', '-2 pears', '=1+1', '@ref']);
    await t.prisma.task.deleteMany({ where: { id: { in: ids } } });
    await t.prisma.searchDocument.deleteMany({ where: { entityId: { in: ids } } });
  });

  it('import_round_trip_preview_commit_and_a_bad_row_writes_nothing', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const marker = `${RUN} imp`;
    const csv = `title,description,dueAt,status\r\n"${marker} one, with comma","line\nbreak",2026-12-01,open\r\n${marker} two,,,done\r\n'=${marker} three,,,\r\n`;
    const count = () => t.prisma.task.count({ where: { OR: [{ title: { contains: marker } }, { description: { contains: marker } }] } });

    const preview = await c.post('/admin/tables/Task/import', { csv, dryRun: true });
    expect(preview.body).toMatchObject({ valid: true, committed: false, rows: 3, errors: [] });
    expect(await count()).toBe(0);

    const committed = await c.post('/admin/tables/Task/import', { csv, dryRun: false });
    expect(committed.body).toMatchObject({ valid: true, committed: true, rows: 3 });
    const made = await t.prisma.task.findMany({ where: { title: { contains: marker } }, orderBy: { title: 'asc' } });
    expect(made.map((x) => x.title).sort()).toEqual([`${marker} one, with comma`, `${marker} two`, `=${marker} three`].sort());
    const one = made.find((x) => x.title.endsWith('with comma'))!;
    expect(one.description).toBe('line\nbreak');
    expect(one.dueAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(made.every((x) => x.status === 'open' && x.source === 'manual')).toBe(true);
    expect(await t.prisma.csvJob.findUnique({ where: { id: committed.body.jobId } })).toMatchObject({ kind: 'import', status: 'completed' });
    expect(await t.prisma.auditLog.count({ where: { entityType: 'Task', entityId: one.id, action: 'common.task.created' } })).toBe(1);

    // One bad row in the middle: nothing is written, errors name row, column and code but never the value.
    const before = await count();
    const bad = `title,dueAt\r\n${marker} ok1,2026-01-01\r\n${marker} secret-value,not-a-date\r\n,2026-01-01\r\n${marker} ok2,\r\n`;
    const res = await c.post('/admin/tables/Task/import', { csv: bad, dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: false, committed: false });
    expect(res.body.errors).toEqual([{ row: 2, column: 'dueAt', code: 'invalid_date' }, { row: 3, column: 'title', code: 'required' }]);
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
    expect(await count()).toBe(before);
    const job = await t.prisma.csvJob.findUniqueOrThrow({ where: { id: res.body.jobId } });
    expect(job.status).toBe('failed');
    expect(JSON.stringify(job.errors)).not.toContain('secret-value');
  });

  it.each([
    ['unknown_column', 'title,colour\r\nx,red\r\n', { row: 0, column: 'colour', code: 'unknown_column' }],
    ['duplicate_column', 'title,title\r\nx,y\r\n', { row: 0, column: 'title', code: 'duplicate_column' }],
    ['missing_required_column', 'description\r\nx\r\n', { row: 0, column: 'title', code: 'missing_column' }],
    ['wrong_cell_count', 'title,dueAt\r\nx\r\n', { row: 1, column: '', code: 'wrong_cell_count' }],
    ['unterminated_quote', 'title\r\n"x\r\n', { row: 0, column: '', code: 'bad_csv' }],
    ['no_rows', 'title\r\n', { row: 0, column: '', code: 'no_rows' }],
    ['empty_file', '', { row: 0, column: '', code: 'empty_file' }],
    ['title_too_long', `title\r\n${'x'.repeat(201)}\r\n`, { row: 1, column: 'title', code: 'too_long' }],
  ])('import_rejects_%s', async (_n, csv, expected) => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const res = await c.post('/admin/tables/Task/import', { csv, dryRun: true });
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toContainEqual(expected);
  });

  it('import_limits_rows_and_size', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const many = `title\r\n${Array.from({ length: 501 }, (_, i) => `r${i}`).join('\r\n')}\r\n`;
    expect((await c.post('/admin/tables/Task/import', { csv: many, dryRun: true })).body.errors).toContainEqual({ row: 0, column: '', code: 'too_many_rows' });
    expect((await c.post('/admin/tables/Task/import', { csv: 'x'.repeat(90_001), dryRun: true })).status).toBe(422);
  });

  it('export_and_import_need_their_own_permissions', async () => {
    const c = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead, K.taskWrite] }));
    expect((await c.post('/admin/tables/Task/export', { query: {} })).status).toBe(403);
    expect((await c.post('/admin/tables/Task/import', { csv: 'title\r\nx\r\n', dryRun: false })).status).toBe(403);
    const exporter = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead, K.taskExport] }));
    const res = await exporter.post('/admin/tables/Task/export', { query: { q: RUN } });
    expect(res.status).toBe(200);
    const job = await t.prisma.csvJob.findFirst({ where: { createdById: exporter.id } });
    expect(job).toMatchObject({ kind: 'export', status: 'completed' });
    expect(await t.prisma.auditLog.count({ where: { entityType: 'CsvJob', entityId: job!.id, action: 'common.csv.exported' } })).toBe(1);
  });
});

describe('tags', () => {
  it('apply_diff_audit_filter_and_restrictions', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const plain = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead, K.taskWrite] }));
    const mkTag = async (name: string, extra: object = {}) => (await c.post('/admin/tags', { name: `${RUN}-${name}`, colour: '#1f6feb', ...extra }));
    expect((await plain.post('/admin/tags', { name: `${RUN}-x`, colour: '#1f6feb' })).status).toBe(403);
    expect((await c.post('/admin/tags', { name: `${RUN}-bad`, colour: 'red' })).status).toBe(422);
    const red = (await mkTag('Red')).body.id;
    const blue = (await mkTag('Blue')).body.id;
    const other = (await mkTag('Other', { entityTypes: ['Booking'] })).body.id;
    expect((await mkTag('red')).status).toBe(409); // names are not case-sensitive

    const x = await mk(c, 'tagX');
    const y = await mk(c, 'tagY');
    expect((await c.put(`/admin/tables/Task/${x}/tags`, { tagIds: [red, blue] })).status).toBe(200);
    expect((await c.put(`/admin/tables/Task/${y}/tags`, { tagIds: [red] })).status).toBe(200);
    expect((await c.put(`/admin/tables/Task/${x}/tags`, { tagIds: [other] })).status).toBe(422);
    expect((await c.put(`/admin/tables/Task/${x}/tags`, { tagIds: [crypto.randomUUID()] })).status).toBe(422);
    expect((await plain.put(`/admin/tables/Task/${x}/tags`, { tagIds: [] })).status).toBe(200);
    expect((await c.put(`/admin/tables/Task/${x}/tags`, { tagIds: [red, blue] })).status).toBe(200);

    const tagged = await rows(c, { tags: red, sort: 'title:asc' });
    expect(tagged.body.total).toBe(2);
    expect(tagged.body.rows[0].tags.map((x: { name: string }) => x.name)).toEqual([`${RUN}-Blue`, `${RUN}-Red`]);
    expect((await rows(c, { tags: `${red},${blue}`, tagMode: 'all' })).body.total).toBe(1);
    expect((await rows(c, { tags: `${red},${blue}`, tagMode: 'any' })).body.total).toBe(2);

    const logs = await t.prisma.auditLog.findMany({ where: { entityType: 'Task', entityId: x, action: 'common.tags.changed' }, orderBy: { occurredAt: 'asc' } });
    expect(logs[0]!.changes).toEqual({ tags: { before: [], after: [`${RUN}-Blue`, `${RUN}-Red`] } });

    // In use: cannot be deleted. Free: can.
    expect((await c.del(`/admin/tags/${red}`)).status).toBe(409);
    await c.put(`/admin/tables/Task/${x}/tags`, { tagIds: [] });
    await c.put(`/admin/tables/Task/${y}/tags`, { tagIds: [] });
    expect((await c.del(`/admin/tags/${red}`)).status).toBe(204);
    expect((await c.patch(`/admin/tags/${blue}`, { colour: '#00aa55' })).status).toBe(200);
    expect(((await c.get('/admin/tags')).body as Array<{ id: string; colour: string }>).find((x) => x.id === blue)!.colour).toBe('#00aa55');

    // A deleted record cannot be tagged.
    await c.post(`/admin/tables/Task/${y}/delete`, {});
    expect((await c.put(`/admin/tables/Task/${y}/tags`, { tagIds: [blue] })).status).toBe(409);
  });
});

describe('notes', () => {
  it('pii_goes_to_audit_pii_values_event_published_author_rules_and_versions', async () => {
    const author = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const peer = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const id = await mk(author, 'noted');
    const added = await author.post(`/admin/tables/Task/${id}/notes`, { body: 'Called the hotel about Ana Pérez' , pinned: true });
    expect(added.status).toBe(201);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Task', entityId: id, action: 'common.note.added' }, include: { piiValues: true } });
    expect(log.changes).toMatchObject({ body: '[pii]', pinned: { before: null, after: true }, _context: { noteId: added.body.id } });
    expect(JSON.stringify(log.changes)).not.toContain('Ana');
    expect(log.piiValues.find((p) => p.field === 'body')?.after).toBe('Called the hotel about Ana Pérez');
    const event = await t.prisma.outboxEvent.findFirst({ where: { type: 'common.note.added', aggregateId: added.body.id } });
    expect(event?.payload).toEqual({ entityType: 'Task', entityId: id });

    const list = (await peer.get(`/admin/tables/Task/${id}/notes`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pinned: true, author: { you: false, email: null } });
    expect((await author.get(`/admin/tables/Task/${id}/notes`)).body[0].author.you).toBe(true);

    expect((await peer.patch(`/admin/tables/Task/${id}/notes/${added.body.id}`, { body: 'x', version: 0 })).status).toBe(403);
    expect((await author.patch(`/admin/tables/Task/${id}/notes/${added.body.id}`, { body: 'Edited', version: 3 })).status).toBe(409);
    expect((await author.patch(`/admin/tables/Task/${id}/notes/${added.body.id}`, { body: 'Edited', version: 0 })).body).toEqual({ version: 1 });
    expect((await author.del(`/admin/tables/Task/${id}/notes/${added.body.id}`)).status).toBe(204);
    expect((await author.get(`/admin/tables/Task/${id}/notes`)).body).toEqual([]);
    expect(await t.prisma.note.count({ where: { id: added.body.id } })).toBe(1); // soft delete keeps the row

    expect((await author.post(`/admin/tables/Task/${id}/notes`, { body: '' })).status).toBe(422);
    const reader = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead] }));
    expect((await reader.post(`/admin/tables/Task/${id}/notes`, { body: 'hi' })).status).toBe(403);
    await author.post(`/admin/tables/Task/${id}/delete`, {});
    expect((await author.post(`/admin/tables/Task/${id}/notes`, { body: 'late' })).status).toBe(409);
  });
});

describe('history', () => {
  it('shows_before_and_after_for_every_changed_field_and_requires_audit_read', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const id = await mk(c, 'hist');
    await c.patch(`/admin/tasks/${id}`, { version: 0, title: title('histRenamed'), status: 'done', reason: 'Wrapped up' });
    expect((await c.patch(`/admin/tasks/${id}`, { version: 0, status: 'open' })).status).toBe(409);
    const history = (await c.get(`/admin/tables/Task/${id}/history`)).body as Array<{ action: string; fields: Array<{ field: string; before: unknown; after: unknown }>; reason: string | null }>;
    const upd = history.find((h) => h.action === 'common.task.updated')!;
    expect(upd.fields).toContainEqual({ field: 'status', before: 'open', after: 'done' });
    expect(upd.fields).toContainEqual({ field: 'title', before: expect.stringContaining('hist'), after: title('histRenamed') });
    expect(upd.reason).toBe('Wrapped up');
    expect(history.find((h) => h.action === 'common.task.created')).toBeTruthy();

    const noAudit = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead] }));
    expect((await noAudit.get(`/admin/tables/Task/${id}/history`)).status).toBe(403);
    expect((await c.get(`/admin/tables/Task/${crypto.randomUUID()}/history`)).status).toBe(404);
  });
});

describe('soft delete', () => {
  it('delete_hides_restore_returns_and_both_are_audited_and_published', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const id = await mk(c, 'soft');
    expect((await c.post(`/admin/tables/Task/${id}/delete`, { reason: 'Duplicate' })).status).toBe(200);
    expect((await c.post(`/admin/tables/Task/${id}/delete`, {})).status).toBe(409);
    expect((await rows(c, { filters: JSON.stringify([{ field: 'title', op: 'contains', value: 'soft' }]) })).body.total).toBe(0);
    expect((await rows(c, { deleted: 'only', pageSize: '100' })).body.rows.map((r: { id: string }) => r.id)).toContain(id);
    expect((await rows(c, { deleted: 'include', pageSize: '100' })).body.rows.map((r: { id: string }) => r.id)).toContain(id);
    expect(await t.prisma.task.findUnique({ where: { id } })).toMatchObject({ deletedById: c.id });
    expect((await c.patch(`/admin/tasks/${id}`, { version: 1, title: title('nope') })).status).toBe(409);

    expect((await c.post(`/admin/tables/Task/${id}/restore`, {})).status).toBe(200);
    expect((await c.post(`/admin/tables/Task/${id}/restore`, {})).status).toBe(409);
    expect(await t.prisma.task.findUnique({ where: { id } })).toMatchObject({ deletedAt: null, deletedById: null });
    const logs = await t.prisma.auditLog.findMany({ where: { entityType: 'Task', entityId: id, action: { in: ['common.task.deleted', 'common.task.restored'] } }, orderBy: { occurredAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['common.task.deleted', 'common.task.restored']);
    expect(logs[0]!.changes).toMatchObject({ deletedAt: { before: null, after: expect.any(String) } });
    expect(await t.prisma.outboxEvent.count({ where: { aggregateId: id, type: { in: ['common.task.deleted', 'common.task.restored'] } } })).toBe(2);

    const noDelete = await as(await createStaff(t, { permissions: [K.tableUse, K.taskRead, K.taskWrite] }));
    expect((await noDelete.post(`/admin/tables/Task/${id}/delete`, {})).status).toBe(403);
    expect((await c.post(`/admin/tables/Task/${crypto.randomUUID()}/delete`, {})).status).toBe(404);
  });

  it('optimistic_lock_on_edit', async () => {
    const c = await as(await createStaff(t, { permissions: TASK_PERMS }));
    const id = await mk(c, 'lock');
    expect((await c.patch(`/admin/tasks/${id}`, { version: 0, title: title('lock2') })).body).toEqual({ id, version: 1 });
    expect((await c.patch(`/admin/tasks/${id}`, { version: 0, title: title('lock3') })).status).toBe(409);
    expect((await c.patch(`/admin/tasks/${id}`, { version: 1, status: 'bogus' })).status).toBe(422);
    expect((await c.patch(`/admin/tasks/${id}`, { version: 1, assigneeId: crypto.randomUUID() })).status).toBe(422);
  });
});
