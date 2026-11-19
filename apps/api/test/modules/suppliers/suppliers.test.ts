import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestApp, makeApp } from '../../support/auth';
import { closeCatalogue, anonymous, Client } from '../../support/catalogue';
import { SP, adminWith, buildWorld, must, setSuppliersFlag, supplierBody, supplierWithContract } from '../../support/suppliers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  t = await makeApp();
  await setSuppliersFlag(t, true);
  admin = await adminWith(t);
});
afterAll(async () => {
  await setSuppliersFlag(t, true);
  await closeCatalogue(t);
});

const outbox = (type: string, id: string) => t.prisma.outboxEvent.count({ where: { type, aggregateId: id } });

describe('access and the module flag', () => {
  it('flag_off_routes_are_404: every supplier route answers 404 to a fully permitted user while the flag is off', async () => {
    await setSuppliersFlag(t, false);
    try {
      for (const path of ['/admin/suppliers', '/admin/suppliers/releases', `/admin/suppliers/${crypto.randomUUID()}`]) expect((await admin.get(path)).status).toBe(404);
      expect((await admin.post('/admin/suppliers', supplierBody())).status).toBe(404);
    } finally {
      await setSuppliersFlag(t, true);
    }
    expect((await admin.get('/admin/suppliers')).status).toBe(200);
  });

  it('anonymous callers are refused', async () => {
    expect([401, 403]).toContain((await anonymous(t).get('/admin/suppliers')).status);
  });

  it('each permission guards its routes; costs have their own pair', async () => {
    const w = await buildWorld(admin);
    const { supplier, contract } = await supplierWithContract(admin, w);
    const readOnly = await adminWith(t, [SP.supplierRead]);
    expect((await readOnly.get('/admin/suppliers')).status).toBe(200);
    expect((await readOnly.post('/admin/suppliers', supplierBody())).status).toBe(403);
    expect((await readOnly.post(`/admin/suppliers/contracts/${contract.id}/allotments`, {})).status).toBe(403);
    expect((await readOnly.get(`/admin/suppliers/${supplier.id}/costs`)).status).toBe(403);
    const costs = await adminWith(t, [SP.costRead]);
    expect((await costs.get(`/admin/suppliers/${supplier.id}/costs`)).status).toBe(200);
    expect((await costs.get(`/admin/suppliers/${supplier.id}`)).status).toBe(403);
    expect((await costs.post(`/admin/suppliers/${supplier.id}/costs`, {})).status).toBe(403);
    const none = await adminWith(t, []);
    expect((await none.get('/admin/suppliers')).status).toBe(403);
  });
});

describe('suppliers, contacts and contracts', () => {
  it('create, read, update with a version, and an old version is a 409', async () => {
    const s = must(await admin.post('/admin/suppliers', supplierBody({ name: 'Zeta Tours', kind: 'ground_operator' })), 'create').body;
    expect(s).toMatchObject({ name: 'Zeta Tours', defaultCurrency: 'DKK', isDemo: false, version: 0 });
    const u = must(await admin.patch(`/admin/suppliers/${s.id}`, { name: 'Zeta Travel', version: 0 }), 'update').body;
    expect(u).toMatchObject({ name: 'Zeta Travel', version: 1 });
    expect((await admin.patch(`/admin/suppliers/${s.id}`, { name: 'Again', version: 0 })).body).toMatchObject({ code: 'version_conflict' });
    const list = (await admin.get('/admin/suppliers?q=zeta')).body;
    expect(list.items.map((i: { id: string }) => i.id)).toContain(s.id);
    expect(await t.prisma.auditLog.count({ where: { entityType: 'Supplier', entityId: s.id } })).toBe(2);
  });

  it('validation: bad currency, country, unknown field and isDemo are 422', async () => {
    for (const body of [supplierBody({ defaultCurrency: 'XXX1' }), supplierBody({ defaultCurrency: 'AUDD' }), supplierBody({ defaultCurrency: 'ZZZ' }), supplierBody({ countryCode: 'dk' }), supplierBody({ isDemo: true }), supplierBody({ name: '' })]) {
      expect((await admin.post('/admin/suppliers', body)).status).toBe(422);
    }
  });

  it('contacts: add, edit, and delete really removes the row; a bad email is 422', async () => {
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    expect((await admin.post(`/admin/suppliers/${s.id}/contacts`, { name: 'Sam', email: 'not-an-email' })).status).toBe(422);
    const c = must(await admin.post(`/admin/suppliers/${s.id}/contacts`, { name: 'Sam Reservations', email: 'sam@example.test', role: 'Reservations' }), 'contact').body;
    expect((await admin.patch(`/admin/suppliers/contacts/${c.id}`, { phone: '+45 1234 5678' })).body.phone).toBe('+45 1234 5678');
    expect((await admin.delete(`/admin/suppliers/contacts/${c.id}`)).status).toBe(204);
    expect(await t.prisma.supplierContact.count({ where: { id: c.id } })).toBe(0);
    expect((await admin.delete(`/admin/suppliers/contacts/${c.id}`)).status).toBe(404);
    // The audit trail does not hold the contact's address in the clear.
    const log = await t.prisma.auditLog.findFirst({ where: { entityType: 'SupplierContact', entityId: c.id, action: 'suppliers.contact.created' } });
    expect(JSON.stringify(log?.changes)).not.toContain('sam@example.test');
  });

  it('contracts: unique reference per supplier, dates must be ordered, edition must exist', async () => {
    const w = await buildWorld(admin);
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    const make = (over: Record<string, unknown>) => admin.post(`/admin/suppliers/${s.id}/contracts`, { reference: 'HB-1', ...over });
    const c = must(await make({ editionId: w.edition.id, validFrom: '2027-01-01', validTo: '2027-12-31' }), 'contract').body;
    expect(c).toMatchObject({ validFrom: '2027-01-01', validTo: '2027-12-31', signedAt: null });
    expect((await make({})).body).toMatchObject({ code: 'contract_reference_taken' });
    expect((await make({ reference: 'HB-2', validFrom: '2027-12-31', validTo: '2027-01-01' })).status).toBe(422);
    expect((await make({ reference: 'HB-3', editionId: crypto.randomUUID() })).body).toMatchObject({ code: 'edition_not_found' });
    expect((await make({ reference: 'HB-4', signedAt: '2027-02-30' })).status).toBe(422);
    const patched = (await admin.patch(`/admin/suppliers/contracts/${c.id}`, { validTo: '2026-12-31', version: 0 }));
    expect(patched.status).toBe(409);
    expect((await admin.patch(`/admin/suppliers/contracts/${c.id}`, { terms: 'Net 30', version: 0 })).body).toMatchObject({ terms: 'Net 30', version: 1 });
  });

  it('delete: a supplier with contracts or open costs stays; contracts with allotments stay; then they go', async () => {
    const w = await buildWorld(admin);
    const { supplier, contract } = await supplierWithContract(admin, w);
    const a = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.roomPoolId, quantity: 5, unitCostMinor: '12000', currency: 'DKK' }), 'allotment').body;
    expect((await admin.delete(`/admin/suppliers/${supplier.id}`)).body).toMatchObject({ code: 'supplier_has_contracts' });
    expect((await admin.delete(`/admin/suppliers/contracts/${contract.id}`)).body).toMatchObject({ code: 'contract_has_allotments' });
    must(await admin.delete(`/admin/suppliers/allotments/${a.id}`), 'delete allotment');
    const cost = must(await admin.post(`/admin/suppliers/${supplier.id}/costs`, { contractId: contract.id, description: 'Deposit', basis: 'fixed', quantity: 1, unitAmountMinor: '100000', currency: 'DKK' }), 'cost').body;
    expect((await admin.delete(`/admin/suppliers/contracts/${contract.id}`)).body).toMatchObject({ code: 'contract_has_costs' });
    must(await admin.post(`/admin/suppliers/costs/${cost.id}/status`, { status: 'cancelled', version: cost.version }), 'cancel');
    expect((await admin.delete(`/admin/suppliers/contracts/${contract.id}`)).status).toBe(204);
    expect((await admin.delete(`/admin/suppliers/${supplier.id}`)).status).toBe(204);
    expect((await admin.get(`/admin/suppliers/${supplier.id}`)).status).toBe(404);
    expect((await admin.post(`/admin/suppliers/${supplier.id}/contracts`, { reference: 'X' })).status).toBe(404);
  });
});

describe('allotments', () => {
  it('create with a release date and a cost in the supplier currency; kind comes from the pool', async () => {
    const w = await buildWorld(admin);
    const { supplier, contract } = await supplierWithContract(admin, w);
    const a = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.roomPoolId, quantity: 8, releaseDate: '2027-04-01', unitCostMinor: '95050', currency: 'DKK' }), 'allotment').body;
    expect(a).toMatchObject({ kind: 'room', quantity: 8, releaseDate: '2027-04-01', unitCostMinor: '95050', currency: 'DKK', status: 'held', releasedAt: null });
    const list = (await admin.get(`/admin/suppliers/${supplier.id}/allotments`)).body;
    expect(list.items).toHaveLength(1);
    expect(list.committedCost).toEqual([{ currency: 'DKK', amountMinor: String(8 * 95050) }]);
  });

  it('refuses an extra pool, a pool of another edition, a release after the race and bad numbers', async () => {
    const w = await buildWorld(admin);
    const other = await buildWorld(admin, { year: 2028 });
    const { contract } = await supplierWithContract(admin, w);
    const post = (over: Record<string, unknown>) => admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.roomPoolId, quantity: 1, unitCostMinor: '100', currency: 'AUD', ...over });
    expect((await post({ poolId: w.extraPoolId })).body).toMatchObject({ code: 'pool_kind_not_allowed' });
    expect((await post({ poolId: other.roomPoolId })).body).toMatchObject({ code: 'pool_edition_mismatch' });
    expect((await post({ poolId: crypto.randomUUID() })).body).toMatchObject({ code: 'pool_not_found' });
    expect((await post({ releaseDate: '2027-06-21' })).body).toMatchObject({ code: 'release_after_event' });
    expect((await post({ releaseDate: '2027-06-20' })).status).toBe(201);
    for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { unitCostMinor: '-1' }, { unitCostMinor: '10.50' }, { unitCostMinor: 100 }, { currency: 'aud' }, { currency: 'QQQ' }, { unitCostMinor: '1000000000001' }, { kind: 'entry' }]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await admin.post(`/admin/suppliers/contracts/${crypto.randomUUID()}/allotments`, { poolId: w.roomPoolId, quantity: 1, unitCostMinor: '1', currency: 'AUD' })).status).toBe(404);
  });

  it('a contract with no edition can cover a pool of any edition', async () => {
    const w = await buildWorld(admin);
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    const c = must(await admin.post(`/admin/suppliers/${s.id}/contracts`, { reference: 'OPEN-1' }), 'contract').body;
    expect((await admin.post(`/admin/suppliers/contracts/${c.id}/allotments`, { poolId: w.entryPoolId, quantity: 3, unitCostMinor: '0', currency: 'AUD' })).body).toMatchObject({ kind: 'entry' });
  });

  it('release is once-only: a second release, an edit after release and a delete after release are 409', async () => {
    const w = await buildWorld(admin);
    const { contract } = await supplierWithContract(admin, w);
    const a = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.roomPoolId, quantity: 4, unitCostMinor: '500', currency: 'AUD' }), 'allotment').body;
    expect((await admin.post(`/admin/suppliers/allotments/${a.id}/release`, { version: 99 })).body).toMatchObject({ code: 'version_conflict' });
    const r = must(await admin.post(`/admin/suppliers/allotments/${a.id}/release`, { version: a.version, reason: 'Unsold' }), 'release').body;
    expect(r).toMatchObject({ status: 'released' });
    expect(r.releasedAt).toBeTruthy();
    expect((await admin.post(`/admin/suppliers/allotments/${a.id}/release`, { version: r.version })).body).toMatchObject({ code: 'allotment_released' });
    expect((await admin.patch(`/admin/suppliers/allotments/${a.id}`, { quantity: 2, version: r.version })).body).toMatchObject({ code: 'allotment_released' });
    expect((await admin.delete(`/admin/suppliers/allotments/${a.id}`)).body).toMatchObject({ code: 'allotment_released' });
    expect(await outbox('suppliers.allotment.released', a.id)).toBe(1);
    expect((await admin.post(`/admin/suppliers/allotments/${crypto.randomUUID()}/release`, { version: 0 })).status).toBe(404);
  });

  it('concurrent releases: one wins, one event', async () => {
    const w = await buildWorld(admin);
    const { contract } = await supplierWithContract(admin, w);
    const a = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.entryPoolId, quantity: 4, unitCostMinor: '500', currency: 'AUD' }), 'allotment').body;
    const results = await Promise.all(Array.from({ length: 6 }, () => admin.post(`/admin/suppliers/allotments/${a.id}/release`, { version: a.version })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await outbox('suppliers.allotment.released', a.id)).toBe(1);
  });

  it('edit changes cost and date while held; the audit shows the change', async () => {
    const w = await buildWorld(admin);
    const { contract } = await supplierWithContract(admin, w);
    const a = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.roomPoolId, quantity: 4, unitCostMinor: '500', currency: 'AUD' }), 'allotment').body;
    const u = must(await admin.patch(`/admin/suppliers/allotments/${a.id}`, { unitCostMinor: '650', releaseDate: '2027-05-01', currency: 'EUR', version: a.version }), 'edit').body;
    expect(u).toMatchObject({ unitCostMinor: '650', releaseDate: '2027-05-01', currency: 'EUR', version: 1 });
    expect((await admin.patch(`/admin/suppliers/allotments/${a.id}`, { releaseDate: '2027-09-01', version: 1 })).body).toMatchObject({ code: 'release_after_event' });
    expect(await t.prisma.auditLog.count({ where: { entityType: 'Allotment', entityId: a.id } })).toBe(2);
  });

  it('allotments never change the stock pool', async () => {
    const w = await buildWorld(admin);
    const { contract } = await supplierWithContract(admin, w);
    const before = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.roomPoolId } });
    const a = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.roomPoolId, quantity: 50, unitCostMinor: '1', currency: 'AUD' }), 'allotment').body;
    must(await admin.post(`/admin/suppliers/allotments/${a.id}/release`, { version: a.version }), 'release');
    const after = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.roomPoolId } });
    expect([after.capacity, after.consumed, after.version]).toEqual([before.capacity, before.consumed, before.version]);
  });
});

describe('release calendar and stock cover', () => {
  it('releases: overdue, due soon, far away, released and undated', async () => {
    const w = await buildWorld(admin);
    const { supplier, contract } = await supplierWithContract(admin, w);
    const mk = async (releaseDate: string | null, poolId = w.roomPoolId) =>
      must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId, quantity: 1, releaseDate, unitCostMinor: '1', currency: 'AUD' }), 'allotment').body;
    const overdue = await mk('2027-01-09');
    const boundary = await mk('2027-02-09');
    const far = await mk('2027-02-10');
    const undated = await mk(null);
    const done = await mk('2027-01-15');
    must(await admin.post(`/admin/suppliers/allotments/${done.id}/release`, { version: done.version }), 'release');
    const res = (await admin.get('/admin/suppliers/releases?withinDays=30&asOf=2027-01-10')).body;
    const mine = res.items.filter((i: { contract: { supplier: { id: string } } }) => i.contract.supplier.id === supplier.id);
    expect(mine.map((i: { id: string }) => i.id)).toEqual([overdue.id, boundary.id]);
    expect(mine.map((i: { overdue: boolean }) => i.overdue)).toEqual([true, false]);
    expect(mine.map((i: { id: string }) => i.id)).not.toContain(far.id);
    expect(mine.map((i: { id: string }) => i.id)).not.toContain(undated.id);
    expect((await admin.get('/admin/suppliers/releases?asOf=2027-13-01')).status).toBe(422);
    expect((await admin.get('/admin/suppliers/releases?withinDays=-1')).status).toBe(422);
  });

  it('coverage: none, partial, exact and more than needed; only held; editions kept apart; costs per currency', async () => {
    const w = await buildWorld(admin);
    const other = await buildWorld(admin, { year: 2028 });
    const { contract } = await supplierWithContract(admin, w);
    const post = (poolId: string, quantity: number, currency = 'AUD', unitCostMinor = '100') => admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId, quantity, unitCostMinor, currency });
    const cov = async (ed: string) => (await admin.get(`/admin/suppliers/coverage?editionId=${ed}`)).body.items as Array<{ poolId: string; capacity: number; contracted: number; uncovered: number; committedCost: Array<{ currency: string; amountMinor: string }> }>;
    let rows = await cov(w.edition.id);
    expect(rows.map((r) => r.poolId).sort()).toEqual([w.entryPoolId, w.roomPoolId].sort());
    expect(rows.find((r) => r.poolId === w.roomPoolId)).toMatchObject({ capacity: 10, contracted: 0, uncovered: 10, committedCost: [] });
    must(await post(w.roomPoolId, 4, 'AUD', '100'), 'a1');
    must(await post(w.roomPoolId, 2, 'EUR', '250'), 'a2');
    rows = await cov(w.edition.id);
    expect(rows.find((r) => r.poolId === w.roomPoolId)).toMatchObject({ contracted: 6, uncovered: 4, committedCost: [{ currency: 'AUD', amountMinor: '400' }, { currency: 'EUR', amountMinor: '500' }] });
    const big = must(await post(w.roomPoolId, 4), 'a3').body;
    expect((await cov(w.edition.id)).find((r) => r.poolId === w.roomPoolId)).toMatchObject({ contracted: 10, uncovered: 0 });
    const more = must(await post(w.roomPoolId, 5), 'a4').body;
    expect((await cov(w.edition.id)).find((r) => r.poolId === w.roomPoolId)).toMatchObject({ contracted: 15, uncovered: 0 });
    must(await admin.post(`/admin/suppliers/allotments/${more.id}/release`, { version: more.version }), 'release');
    expect((await cov(w.edition.id)).find((r) => r.poolId === w.roomPoolId)).toMatchObject({ contracted: 10 });
    expect(big.id).toBeTruthy();
    expect((await cov(other.edition.id)).find((r) => r.poolId === other.roomPoolId)).toMatchObject({ contracted: 0 });
    expect((await admin.get(`/admin/suppliers/coverage?editionId=${crypto.randomUUID()}`)).status).toBe(404);
    expect((await admin.get('/admin/suppliers/coverage')).status).toBe(422);
  });
});

describe('cost items', () => {
  const cost = (over: Record<string, unknown> = {}) => ({ description: 'Hotel block, 8 rooms', basis: 'per_room', quantity: 8, unitAmountMinor: '95050', currency: 'DKK', ...over });

  it('the server works out the amount; the client cannot send one', async () => {
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    const c = must(await admin.post(`/admin/suppliers/${s.id}/costs`, cost({ dueDate: '2027-05-01' })), 'cost').body;
    expect(c).toMatchObject({ quantity: 8, unitAmountMinor: '95050', amountMinor: '760400', currency: 'DKK', status: 'planned', dueDate: '2027-05-01' });
    expect((await admin.post(`/admin/suppliers/${s.id}/costs`, { ...cost(), amountMinor: '1' })).status).toBe(422);
    const u = must(await admin.patch(`/admin/suppliers/costs/${c.id}`, { quantity: 10, version: c.version }), 'edit').body;
    expect(u).toMatchObject({ quantity: 10, amountMinor: '950500' });
    const v = must(await admin.patch(`/admin/suppliers/costs/${c.id}`, { unitAmountMinor: '1', version: u.version }), 'edit2').body;
    expect(v.amountMinor).toBe('10');
  });

  it('table: boundary quantities and amounts', async () => {
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    const rows: Array<[number, string, number, string | null]> = [
      [1, '0', 201, '0'], [1, '1', 201, '1'], [100000, '1000000000000', 201, '100000000000000000'], [100001, '1', 422, null], [0, '1', 422, null], [1, '1000000000001', 422, null], [2, '-5', 422, null],
    ];
    for (const [quantity, unit, status, amount] of rows) {
      const r = await admin.post(`/admin/suppliers/${s.id}/costs`, cost({ quantity, unitAmountMinor: unit, basis: 'per_person' }));
      expect(r.status, `${quantity} x ${unit}`).toBe(status);
      if (amount !== null) expect(r.body.amountMinor).toBe(amount);
    }
  });

  it('a fixed cost has a quantity of one; links must belong to the same supplier', async () => {
    const w = await buildWorld(admin);
    const { supplier, contract } = await supplierWithContract(admin, w);
    const other = must(await admin.post('/admin/suppliers', supplierBody({ name: 'Other' })), 'other').body;
    expect((await admin.post(`/admin/suppliers/${supplier.id}/costs`, cost({ basis: 'fixed', quantity: 2 }))).body).toMatchObject({ code: 'fixed_cost_quantity' });
    expect((await admin.post(`/admin/suppliers/${other.id}/costs`, cost({ contractId: contract.id }))).body).toMatchObject({ code: 'contract_supplier_mismatch' });
    expect((await admin.post(`/admin/suppliers/${supplier.id}/costs`, cost({ contractId: crypto.randomUUID() }))).body).toMatchObject({ code: 'contract_not_found' });
    expect((await admin.post(`/admin/suppliers/${supplier.id}/costs`, cost({ packageId: crypto.randomUUID() }))).body).toMatchObject({ code: 'package_not_found' });
    expect((await admin.post(`/admin/suppliers/${supplier.id}/costs`, cost({ packageId: w.pkg.id, contractId: contract.id }))).status).toBe(201);
    expect((await admin.post(`/admin/suppliers/${crypto.randomUUID()}/costs`, cost())).status).toBe(404);
  });

  it('status: planned and due move, cancelled is final, paid cannot be set', async () => {
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    const c = must(await admin.post(`/admin/suppliers/${s.id}/costs`, cost()), 'cost').body;
    const due = must(await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'due', version: c.version }), 'due').body;
    expect((await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'paid', version: due.version })).status).toBe(422);
    expect((await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'due', version: due.version })).body).toMatchObject({ code: 'transition_not_allowed' });
    const back = must(await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'planned', version: due.version }), 'back').body;
    const cancelled = must(await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'cancelled', version: back.version }), 'cancel').body;
    expect((await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'planned', version: cancelled.version })).body).toMatchObject({ code: 'transition_not_allowed' });
    expect((await admin.patch(`/admin/suppliers/costs/${c.id}`, { quantity: 1, version: cancelled.version })).body).toMatchObject({ code: 'cost_not_editable' });
    expect((await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'due', version: 0 })).body).toMatchObject({ code: expect.stringMatching(/version_conflict|transition_not_allowed/) });
  });

  it('a paid item (set by 6.2 later) cannot be edited or moved', async () => {
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    const c = must(await admin.post(`/admin/suppliers/${s.id}/costs`, cost()), 'cost').body;
    // Task 6.2: `paid` is reached only by recording a supplier payment (the database refuses it otherwise), so the item is
    // paid the way the panel does it; the assertions are unchanged.
    must(await admin.post(`/admin/suppliers/${s.id}/payments`, { items: [{ costItemId: c.id, version: c.version }], paidOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date()), reference: 'INV-1' }).set('Idempotency-Key', `k-${crypto.randomUUID()}`), 'pay');
    expect((await admin.patch(`/admin/suppliers/costs/${c.id}`, { quantity: 1, version: 1 })).body).toMatchObject({ code: 'cost_not_editable' });
    expect((await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'cancelled', version: 1 })).body).toMatchObject({ code: 'transition_not_allowed' });
  });

  it('summary groups by currency and status, never across currencies, and skips cancelled', async () => {
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    const add = async (over: Record<string, unknown>) => must(await admin.post(`/admin/suppliers/${s.id}/costs`, cost(over)), 'cost').body;
    await add({ quantity: 1, unitAmountMinor: '100', currency: 'DKK' });
    await add({ quantity: 2, unitAmountMinor: '100', currency: 'DKK' });
    await add({ quantity: 1, unitAmountMinor: '70', currency: 'EUR' });
    const gone = await add({ quantity: 1, unitAmountMinor: '999', currency: 'EUR' });
    must(await admin.post(`/admin/suppliers/costs/${gone.id}/status`, { status: 'cancelled', version: gone.version }), 'cancel');
    const res = (await admin.get(`/admin/suppliers/${s.id}/costs`)).body;
    expect(res.summary).toEqual([{ currency: 'DKK', status: 'planned', amountMinor: '300' }, { currency: 'EUR', status: 'planned', amountMinor: '70' }]);
  });

  it('the database refuses an amount that is not quantity times unit, and a negative one', async () => {
    const s = must(await admin.post('/admin/suppliers', supplierBody()), 'create').body;
    const base = { supplierId: s.id, description: 'x', basis: 'per_person' as const, quantity: 2, currency: 'AUD' };
    await expect(t.prisma.costItem.create({ data: { ...base, unitAmountMinor: 10n, amountMinor: 21n } })).rejects.toThrow();
    await expect(t.prisma.costItem.create({ data: { ...base, unitAmountMinor: -10n, amountMinor: -20n } })).rejects.toThrow();
    await expect(t.prisma.costItem.create({ data: { ...base, unitAmountMinor: 10n, amountMinor: 20n, currency: 'aud' } })).rejects.toThrow();
  });
});
