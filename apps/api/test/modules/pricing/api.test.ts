// Pricing through HTTP and a real PostgreSQL (plan 2.1, sections 7 and 12).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PRICING_PERMISSIONS as PP } from '../../../src/modules/pricing';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { CATALOGUE_AND_PRICING, Client, P, buildWorld, closeCatalogue, setSale, staffClient } from '../../support/catalogue';
import { allRoutes } from '../../support/routes';
import { cardFor, currentOf, draftWith, must, pricedWorld, publishDraft, publishWith, quoteBody, text } from '../../support/pricing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, CATALOGUE_AND_PRICING);
});
afterAll(async () => {
  await closeCatalogue(t);
});

const publicQuote = (body: object) => t.http().post('/pricing/quotes').set(STATE_HEADERS).send(body);

describe('public quotes', () => {
  it('an open package: total, breakdown and deposit from the API, amounts as strings, no rule trace', async () => {
    const w = await pricedWorld(admin);
    const res = await publicQuote(quoteBody(w));
    expect(res.status).toBe(200);
    // double room for two (2 × 50 000) + marathon 30 000 + supporter 2 500
    expect(res.body).toMatchObject({ currency: 'AUD', totalMinor: '132500', depositMinor: '100000', balanceMinor: '32500', priceVersionId: w.versionId, engineVersion: 'pricing-2.1.0', promo: { status: 'none' } });
    expect(res.body.trace).toBeUndefined();
    expect(res.body.lines.every((l: { amountMinor: unknown }) => typeof l.amountMinor === 'string')).toBe(true);
    const { priceBreakdownSchema } = await import('@mt/shared');
    expect(priceBreakdownSchema.safeParse(res.body).success).toBe(true);
  });

  it('quote_request_rejects_amount_fields: an amount, a price or a date anywhere is a 422', async () => {
    const w = await pricedWorld(admin);
    const base = quoteBody(w);
    const bodies = [
      { ...base, totalMinor: '1' },
      { ...base, priceMinor: '1' },
      { ...base, rooms: [{ ...base.rooms[0], travellers: [{ participationType: 'runner_with_entry', raceDistanceId: w.distanceId, priceMinor: '1' }] }] },
      { ...base, rooms: [{ ...base.rooms[0], amountMinor: '1' }] },
      { ...base, extras: [{ extraId: w.extraId, travellerSlots: [1], amountMinor: '1' }] },
      { ...base, now: '2027-01-01T00:00:00Z' },
      { ...base, date: '2027-01-01' },
      { ...base, priceVersionId: w.versionId },
      { ...base, depositMinor: '0' },
    ];
    for (const b of bodies) expect((await publicQuote(b)).status, JSON.stringify(Object.keys(b))).toBe(422);
    expect((await publicQuote(base)).status).toBe(200);
  });

  it('public_quote_only_for_open_packages: draft, coming soon, closed, unpublished race or deleted all answer the same 404', async () => {
    const draft = await pricedWorld(admin, { open: false });
    const bodies: object[] = [];
    bodies.push(quoteBody(draft));
    const soon = await pricedWorld(admin, { open: false });
    await must(setSale(admin, soon.pkg.id, 'coming_soon'), 'coming soon');
    bodies.push(quoteBody(soon));
    const closed = await pricedWorld(admin);
    await must(setSale(admin, closed.pkg.id, 'closed'), 'closed');
    bodies.push(quoteBody(closed));
    const hidden = await pricedWorld(admin);
    await must(admin.post(`/admin/catalogue/races/${hidden.race.id}/status`, { status: 'draft', version: hidden.race.version + 1 }), 'unpublish race');
    bodies.push(quoteBody(hidden));
    bodies.push(quoteBody({ ...draft, pkg: { id: crypto.randomUUID() } }));
    const answers = await Promise.all(bodies.map((b) => publicQuote(b)));
    for (const a of answers) expect([a.status, a.body]).toEqual([404, { code: 'package_not_found', message: 'Package not found' }]);
  });

  it('a configuration error is a 422 with a stable code; a promo code answers "invalid" until 2.2 stores codes', async () => {
    const w = await pricedWorld(admin);
    const three = quoteBody(w, { rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'supporter' }, { participationType: 'supporter' }, { participationType: 'supporter' }] }] });
    expect((await publicQuote(three)).body.code).toBe('occupancy_out_of_range');
    const ownEntry = quoteBody(w, { rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'runner_own_entry' }] }] });
    expect((await publicQuote(ownEntry)).body.code).toBe('participation_not_offered');
    const code = await publicQuote(quoteBody(w, { promoCode: 'SPRING' }));
    expect([code.status, code.body.promo, code.body.totalMinor]).toEqual([200, { status: 'invalid' }, '132500']);
  });
});

describe('versions and the price in force', () => {
  it('quote_uses_version_valid_at_now: a new version replaces the old one at once; the old one keeps its rates', async () => {
    const w = await pricedWorld(admin);
    expect((await publicQuote(quoteBody(w))).body.totalMinor).toBe('132500');
    const dearer = { ...w.rates, roomRates: w.rates.roomRates.map((r) => ({ ...r, pricePerPersonMinor: String(BigInt(r.pricePerPersonMinor) + 1000n) })) };
    const v2 = await publishWith(admin, w.pkg.id, dearer, 'Dearer');
    const q = (await publicQuote(quoteBody(w))).body;
    expect([q.totalMinor, q.priceVersionId]).toEqual(['134500', v2]);
    const old = (await admin.get(`/admin/pricing/price-versions/${w.versionId}`)).body;
    expect(old.status).toBe('published');
    expect(old.validTo).not.toBeNull();
    expect(old.rates.roomRates.map((r: { pricePerPersonMinor: string }) => r.pricePerPersonMinor)).toEqual(['80000', '50000']);
    const now = (await admin.get(`/admin/pricing/price-versions/${v2}`)).body;
    expect(now.validFrom).toBe(old.validTo);
    expect((await admin.get(`/admin/pricing/packages/${w.pkg.id}/price-versions`)).body.currentId).toBe(v2);
  });

  it('copyCurrent starts a draft from the rates in force', async () => {
    const w = await pricedWorld(admin);
    const d = (await admin.post(`/admin/pricing/packages/${w.pkg.id}/price-versions`, { label: 'Copy', copyCurrent: true })).body;
    expect(d.rates.roomRates).toHaveLength(2);
    expect(d.missing).toEqual([]);
  });

  it('publish_incomplete_version_rejected (any package, and one on sale); the panel sees what is missing', async () => {
    const w = await buildWorld(admin, { priced: false });
    const draft = await draftWith(admin, w.pkg.id, { roomRates: [], participationRates: [], extraRates: [] });
    const missing = (await admin.get(`/admin/pricing/price-versions/${draft.id}`)).body.missing;
    expect(missing.map((m: { kind: string }) => m.kind).sort()).toEqual(['extra', 'room', 'room']);
    const res = await publishDraft(admin, w.pkg.id, draft);
    expect([res.status, res.body.code]).toEqual([409, 'price_version_incomplete']);
    const live = await pricedWorld(admin);
    const partial = await draftWith(admin, live.pkg.id, { ...live.rates, extraRates: [] });
    expect((await publishDraft(admin, live.pkg.id, partial)).body.code).toBe('price_version_incomplete');
    expect((await publicQuote(quoteBody(live))).body.priceVersionId).toBe(live.versionId);
  });

  it('open_gate_requires_current_complete_price_version', async () => {
    const w = await buildWorld(admin, { priced: false });
    expect((await setSale(admin, w.pkg.id, 'open')).body.code).toBe('no_current_price_version');
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    const ids = { roomId: pkg.hotels[0].rooms[0].id, extraId: pkg.extras[0].id, distanceId: w.distanceId };
    await publishWith(admin, w.pkg.id, { ...cardFor(ids), participationRates: [] });
    // a new extra on a package that is not on sale is allowed, but the prices in force no longer cover it
    await must(admin.post(`/admin/catalogue/packages/${w.pkg.id}/extras`, { kind: 'meal', name: text('Pasta night'), pricingUnit: 'per_person' }), 'extra', 201);
    expect((await setSale(admin, w.pkg.id, 'open')).body.code).toBe('price_version_incomplete');
    const extras = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body.extras as Array<{ id: string }>;
    await publishWith(admin, w.pkg.id, { ...cardFor(ids), participationRates: [], extraRates: extras.map((e) => ({ extraId: e.id, amountMinor: '4500' })) });
    expect((await setSale(admin, w.pkg.id, 'open')).status).toBe(200);
  });

  it('missing_rate_is_error_not_zero: a preview of a draft without the rate is a 409, never a 0', async () => {
    const w = await pricedWorld(admin);
    const draft = await draftWith(admin, w.pkg.id, { ...w.rates, participationRates: w.rates.participationRates.filter((r) => r.participationType !== 'supporter') });
    const res = await admin.post('/admin/pricing/quotes', quoteBody(w, { priceVersionId: draft.id }));
    expect([res.status, res.body.code]).toEqual([409, 'rate_missing']);
    const ok = await admin.post('/admin/pricing/quotes', quoteBody(w, { priceVersionId: draft.id, rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'runner_with_entry', raceDistanceId: w.distanceId }] }] }));
    expect([ok.status, ok.body.totalMinor, ok.body.trace]).toEqual([200, '110000', []]);
  });
});

describe('rates', () => {
  it('rate_above_limit_rejected, rate_target_not_in_package, duplicates and the distance rule are 422', async () => {
    const w = await pricedWorld(admin);
    const other = await pricedWorld(admin);
    const d = (await admin.post(`/admin/pricing/packages/${w.pkg.id}/price-versions`, { label: 'Bad' })).body;
    const put = (rates: object) => admin.put(`/admin/pricing/price-versions/${d.id}/rates`, { version: d.version, ...w.rates, ...rates });
    expect((await put({ extraRates: [{ extraId: w.extraId, amountMinor: '100000001' }] })).status).toBe(422);
    expect((await put({ extraRates: [{ extraId: w.extraId, amountMinor: '-1' }] })).status).toBe(422);
    expect((await put({ extraRates: [{ extraId: w.extraId, amountMinor: '1.5' }] })).status).toBe(422);
    expect((await put({ extraRates: [{ extraId: other.extraId, amountMinor: '1' }] })).body.code).toBe('rate_target_not_in_package');
    expect((await put({ roomRates: [{ roomOptionId: other.roomId, occupancy: 1, pricePerPersonMinor: '1', extraNightPerPersonMinor: '1' }] })).body.code).toBe('rate_target_not_in_package');
    expect((await put({ participationRates: [{ participationType: 'runner_with_entry', raceDistanceId: other.distanceId, amountPerPersonMinor: '1' }] })).body.code).toBe('rate_target_not_in_package');
    expect((await put({ extraRates: [{ extraId: w.extraId, amountMinor: '1' }, { extraId: w.extraId, amountMinor: '2' }] })).body.code).toBe('rate_duplicated');
    expect((await put({ participationRates: [{ participationType: 'supporter', raceDistanceId: w.distanceId, amountPerPersonMinor: '1' }] })).body.code).toBe('distance_required_iff_runner_with_entry');
    expect((await put({ participationRates: [{ participationType: 'runner_with_entry', raceDistanceId: null, amountPerPersonMinor: '1' }] })).body.code).toBe('distance_required_iff_runner_with_entry');
  });

  it('set_rates_version_conflict_409 and set_rates_audited_before_after', async () => {
    const w = await pricedWorld(admin);
    const d = (await admin.post(`/admin/pricing/packages/${w.pkg.id}/price-versions`, { label: 'Edit' })).body;
    const first = await admin.put(`/admin/pricing/price-versions/${d.id}/rates`, { version: d.version, ...w.rates });
    expect(first.status).toBe(200);
    const stale = await admin.put(`/admin/pricing/price-versions/${d.id}/rates`, { version: d.version, ...w.rates, extraRates: [] });
    expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
    await must(admin.put(`/admin/pricing/price-versions/${d.id}/rates`, { version: first.body.version, ...w.rates, extraRates: [{ extraId: w.extraId, amountMinor: '13000' }] }), 'second edit');
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'pricing.price_version.rates_set', entityId: d.id }, orderBy: { occurredAt: 'desc' } });
    expect(log.changes).toMatchObject({ extraRates: { before: [{ extraId: w.extraId, amountMinor: '12000' }], after: [{ extraId: w.extraId, amountMinor: '13000' }] } });
  });

  it('a published version cannot be edited, discarded or published again; a draft can be discarded', async () => {
    const w = await pricedWorld(admin);
    const pub = (await admin.get(`/admin/pricing/price-versions/${w.versionId}`)).body;
    expect((await admin.put(`/admin/pricing/price-versions/${w.versionId}/rates`, { version: pub.version, ...w.rates })).body.code).toBe('price_version_not_draft');
    expect((await admin.delete(`/admin/pricing/price-versions/${w.versionId}`)).body.code).toBe('price_version_not_draft');
    expect((await publishDraft(admin, w.pkg.id, { id: w.versionId, version: pub.version })).body.code).toBe('price_version_not_draft');
    const d = await draftWith(admin, w.pkg.id, w.rates);
    expect((await admin.delete(`/admin/pricing/price-versions/${d.id}`)).status).toBe(204);
    expect((await admin.get(`/admin/pricing/price-versions/${d.id}`)).status).toBe(404);
  });
});

describe('publishing', () => {
  it('publish_requires_step_up_and_is_audited, with its event in the outbox', async () => {
    const w = await pricedWorld(admin);
    const publisher = await staffClient(t, [PP.versionManage, PP.versionPublish, PP.versionRead]);
    const d = await draftWith(publisher, w.pkg.id, w.rates);
    await t.prisma.session.updateMany({ where: { userId: publisher.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const old = await publisher.post(`/admin/pricing/price-versions/${d.id}/publish`, { version: d.version, replacesVersionId: w.versionId });
    expect([old.status, old.body.code]).toEqual([403, 'step_up_required']);
    const ok = await admin.post(`/admin/pricing/price-versions/${d.id}/publish`, { version: d.version, replacesVersionId: w.versionId, reason: 'Hotel raised its rates' });
    expect(ok.status).toBe(200);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'pricing.price_version.published', entityId: d.id } });
    expect(log.changes).toMatchObject({ status: { before: 'draft', after: 'published' } });
    const event = await t.prisma.outboxEvent.findFirstOrThrow({ where: { type: 'pricing.price_version.published', aggregateId: d.id } });
    expect(event.payload).toMatchObject({ priceVersionId: d.id, packageId: w.pkg.id, previousVersionId: w.versionId });
  });

  it('concurrent_publish_one_wins: two drafts at once, and one draft twice', async () => {
    const w = await pricedWorld(admin);
    const a = await draftWith(admin, w.pkg.id, w.rates, 'A');
    const b = await draftWith(admin, w.pkg.id, w.rates, 'B');
    const two = await Promise.all([a, b].map((d) => admin.post(`/admin/pricing/price-versions/${d.id}/publish`, { version: d.version, replacesVersionId: w.versionId })));
    expect(two.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(two.find((r) => r.status === 409)!.body.code).toBe('current_version_changed');
    const c = await draftWith(admin, w.pkg.id, w.rates, 'C');
    const current = await currentOf(admin, w.pkg.id);
    const twice = await Promise.all([1, 2].map(() => admin.post(`/admin/pricing/price-versions/${c.id}/publish`, { version: c.version, replacesVersionId: current })));
    expect(twice.map((r) => r.status).sort()).toEqual([200, 409]);
    const live = await t.prisma.priceVersion.findMany({ where: { packageId: w.pkg.id, status: 'published', validTo: null } });
    expect(live).toHaveLength(1);
  });
});

describe('a package on sale always prices (G1)', () => {
  it('catalogue_change_breaking_completeness_rejected_while_open: extra, occupancy, participation and entry', async () => {
    const w = await pricedWorld(admin);
    const before = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    // a mandatory extra cannot be priced before it exists: refused while on sale
    const extra = await admin.post(`/admin/catalogue/packages/${w.pkg.id}/extras`, { kind: 'transfer', name: text('Airport transfer'), pricingUnit: 'per_booking', mandatory: true });
    expect([extra.status, extra.body.code]).toEqual([409, 'price_version_incomplete']);
    // more people in the room: refused until a version prices the new occupancy
    const widen = () => admin.patch(`/admin/catalogue/packages/${w.pkg.id}/rooms/${w.roomId}`, { maxOccupancy: 3 });
    expect((await widen()).body.code).toBe('price_version_incomplete');
    // supporters → own-entry runners too: refused until priced
    const types = () => admin.put(`/admin/catalogue/packages/${w.pkg.id}/participation`, { types: ['runner_with_entry', 'runner_own_entry', 'supporter'] });
    expect((await types()).body.code).toBe('price_version_incomplete');
    // a second distance: refused until priced
    const half = (await must(admin.post(`/admin/catalogue/races/${w.race.id}/distances`, { kind: 'half', distanceMetres: 21097, name: text('Half') }), 'distance', 201)).body;
    const entry = () => admin.post(`/admin/catalogue/packages/${w.pkg.id}/entry-options`, { raceDistanceId: half.id, entryPoolId: w.entryPoolId });
    expect((await entry()).body.code).toBe('price_version_incomplete');
    // nothing changed
    const after = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    expect([after.extras.length, after.hotels[0].rooms[0].maxOccupancy, after.participationOptions.length, after.entryOptions.length]).toEqual([before.extras.length, 2, 2, 1]);
    // price first, then the same changes pass
    await publishWith(admin, w.pkg.id, {
      ...w.rates,
      roomRates: [...w.rates.roomRates, { roomOptionId: w.roomId, occupancy: 3, pricePerPersonMinor: '40000', extraNightPerPersonMinor: '12000' }],
      participationRates: [...w.rates.participationRates, { participationType: 'runner_own_entry', raceDistanceId: null, amountPerPersonMinor: '5000' }, { participationType: 'runner_with_entry', raceDistanceId: half.id, amountPerPersonMinor: '20000' }],
    });
    expect((await widen()).status).toBe(200);
    expect((await types()).status).toBe(200);
    expect((await entry()).status).toBe(201);
  });

  it('remove_room_with_rates_returns_409_not_500, and distances and entry options with rates are 409 too', async () => {
    const w = await pricedWorld(admin, { open: false });
    const room = await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/rooms/${w.roomId}`);
    expect([room.status, room.body.code]).toEqual([409, 'room_has_rates']);
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    const entryId = pkg.entryOptions[0].id;
    // a draft that prices the distance blocks removing the entry option
    const d = await draftWith(admin, w.pkg.id, w.rates);
    const blocked = await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/entry-options/${entryId}`);
    expect([blocked.status, blocked.body.code]).toEqual([409, 'entry_option_has_rates']);
    await must(admin.delete(`/admin/pricing/price-versions/${d.id}`), 'discard', 204);
    // with only the published (frozen) version pricing it, the entry option goes; the distance stays, its rates are history
    expect((await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/entry-options/${entryId}`)).status).toBe(200);
    const dist = await admin.delete(`/admin/catalogue/distances/${w.distanceId}`);
    expect([dist.status, dist.body.code]).toEqual([409, 'distance_has_rates']);
  });
});

describe('permissions', () => {
  const routes = () => allRoutes(t.app).filter((r) => r.path.startsWith('/admin/pricing'));
  const fill = (path: string) => path.replace(/:\w+/g, () => crypto.randomUUID());

  it('price_version_routes_require_permission: 401 without a session, 403 without the permission', async () => {
    const nobody = await staffClient(t, [P.packageRead]);
    expect(routes().length).toBe(7);
    for (const r of routes()) {
      const method = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
      expect((await t.http()[method](fill(r.path)).set(STATE_HEADERS).send({})).status, `${r.method} ${r.path}`).toBe(401);
      const denied = method === 'get' ? await nobody.get(fill(r.path)) : await nobody[method](fill(r.path), {} as never);
      expect(denied.status, `${r.method} ${r.path}`).toBe(403);
    }
  });

  it('each admin route names one pricing permission and every pricing permission is used; the quote route is public', () => {
    const used = new Set(routes().map((r) => (r.marks[0] as { key: string }).key));
    expect([...used].sort()).toEqual(Object.values(PP).sort());
    expect(allRoutes(t.app).filter((r) => r.path.startsWith('/pricing')).map((r) => r.marks[0]?.type)).toEqual(['public']);
  });
});
