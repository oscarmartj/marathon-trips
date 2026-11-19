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
    expect(res.body).toMatchObject({ currency: 'AUD', totalMinor: '132500', depositMinor: '100000', balanceMinor: '32500', priceVersionId: w.versionId, engineVersion: 'pricing-2.2.0', promo: { status: 'none' } });
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

  it('public_quote_only_for_open_packages: draft, coming soon, closed, unpublished race, deleted or unknown all answer the same 404', async () => {
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
    const deleted = await pricedWorld(admin, { open: false });
    await must(admin.delete(`/admin/catalogue/packages/${deleted.pkg.id}`), 'delete package', 204);
    bodies.push(quoteBody(deleted));
    bodies.push(quoteBody({ ...draft, pkg: { id: crypto.randomUUID() } }));
    const answers = await Promise.all(bodies.map((b) => publicQuote(b)));
    for (const a of answers) expect([a.status, a.body]).toEqual([404, { code: 'package_not_found', message: 'Package not found' }]);
  });

  it('public_quote_prices_full_packages: sold out and waitlist packages are priced so a person can join their waiting list (task 6.5)', async () => {
    for (const status of ['sold_out', 'waitlist'] as const) {
      const w = await pricedWorld(admin);
      await must(setSale(admin, w.pkg.id, status), status);
      const a = await publicQuote(quoteBody(w));
      expect([a.status, a.body.totalMinor]).toEqual([200, '132500']);
    }
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

  it('copyCurrent starts a draft from the rates in force, leaves out deleted extras and audits what it copied', async () => {
    const w = await pricedWorld(admin);
    const d = (await admin.post(`/admin/pricing/packages/${w.pkg.id}/price-versions`, { label: 'Copy', copyCurrent: true })).body;
    expect(d.rates.roomRates).toHaveLength(2);
    expect(d.missing).toEqual([]);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'pricing.price_version.created', entityId: d.id } });
    expect(log.changes).toMatchObject({ extraRates: { before: null, after: [{ extraId: w.extraId, amountMinor: '12000' }] } });
    const closed = await pricedWorld(admin);
    await must(setSale(admin, closed.pkg.id, 'closed'), 'close');
    await must(admin.delete(`/admin/catalogue/packages/${closed.pkg.id}/extras/${closed.extraId}`), 'delete extra');
    const d2 = (await admin.post(`/admin/pricing/packages/${closed.pkg.id}/price-versions`, { label: 'Copy', copyCurrent: true })).body;
    expect([d2.rates.extraRates, d2.rates.roomRates.length]).toEqual([[], 2]);
  });

  it('a version starts exactly where the previous one ends; the closing is audited; quotes switch at that instant', async () => {
    const w = await pricedWorld(admin);
    const v2 = await publishWith(admin, w.pkg.id, w.rates, 'Second');
    const [first, second] = await Promise.all([w.versionId, v2].map((id) => t.prisma.priceVersion.findUniqueOrThrow({ where: { id } })));
    expect(first!.validTo!.getTime()).toBe(second!.validFrom!.getTime());
    const { versionInForce } = await import('../../../src/modules/pricing/rates');
    const at = second!.validFrom!;
    expect((await versionInForce(t.prisma, w.pkg.id, at))!.id).toBe(v2);
    expect((await versionInForce(t.prisma, w.pkg.id, new Date(at.getTime() - 1)))!.id).toBe(w.versionId);
    const closing = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'pricing.price_version.closed', entityId: w.versionId } });
    expect(closing.changes).toMatchObject({ validTo: { before: null, after: at.toISOString() }, _context: { successorVersionId: v2 } });
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
    // discarding archives: the row and its rates stay, frozen, and it is never priced or published
    const archived = (await admin.get(`/admin/pricing/price-versions/${d.id}`)).body;
    expect([archived.status, archived.rates.extraRates.length]).toEqual(['archived', 0]);
    const discardLog = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'pricing.price_version.discarded', entityId: d.id } });
    expect(discardLog.changes).toMatchObject({ extraRates: { before: [{ extraId: w.extraId, amountMinor: '12000' }], after: [] } });
    expect((await admin.put(`/admin/pricing/price-versions/${d.id}/rates`, { version: archived.version, ...w.rates })).body.code).toBe('price_version_not_draft');
    expect((await publishDraft(admin, w.pkg.id, { id: d.id, version: archived.version })).body.code).toBe('price_version_not_draft');
    expect((await admin.post('/admin/pricing/quotes', quoteBody(w, { priceVersionId: d.id }))).status).toBe(404);
    expect(await t.prisma.auditLog.count({ where: { action: 'pricing.price_version.discarded', entityId: d.id } })).toBe(1);
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

describe('price_version_overlap: the database constraint behind publishing', () => {
  it('a publish that would overlap a later published version is a 409, not a 500 (23P01)', async () => {
    // Since 2.2 the package lock and the compare-and-set on the timeline stop this before the database does, so the
    // EXCLUDE is made to fire for real: the publish's transaction is replaced, once, by a statement that overlaps.
    const w = await pricedWorld(admin);
    const d = await draftWith(admin, w.pkg.id, w.rates, 'Overlapping');
    const replacesVersionId = await currentOf(admin, w.pkg.id);
    const spy = vi.spyOn(t.prisma, '$transaction').mockImplementationOnce((async () =>
      t.prisma.$executeRawUnsafe(`UPDATE price_versions SET status = 'published', "validFrom" = now(), "pricedTerms" = '[]' WHERE id = $1::uuid`, d.id)) as never);
    try {
      const res = await admin.post(`/admin/pricing/price-versions/${d.id}/publish`, { version: d.version, replacesVersionId });
      expect([res.status, res.body.code]).toEqual([409, 'price_version_overlap']);
    } finally {
      spy.mockRestore();
    }
    expect((await t.prisma.priceVersion.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('draft');
  });
});

describe('a scheduled version ahead of a publish (2.2 replaces the 2.1 test that forced one in by SQL)', () => {
  it('publishing now with a version scheduled later: 409 later_version_scheduled, or current_version_changed if the publisher did not see it', async () => {
    const w = await buildWorld(admin, { priced: false });
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    const rates = { ...cardFor({ roomId: pkg.hotels[0].rooms[0].id, extraId: pkg.extras[0].id, distanceId: w.distanceId }), participationRates: [] };
    const future = await draftWith(admin, w.pkg.id, rates, 'From next week');
    const at = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    await must(admin.post(`/admin/pricing/price-versions/${future.id}/publish`, { version: future.version, replacesVersionId: null, validFrom: at }), 'schedule');
    const now = await draftWith(admin, w.pkg.id, rates, 'From now');
    const blind = await admin.post(`/admin/pricing/price-versions/${now.id}/publish`, { version: now.version, replacesVersionId: null });
    expect([blind.status, blind.body.code]).toEqual([409, 'current_version_changed']);
    const seen = await admin.post(`/admin/pricing/price-versions/${now.id}/publish`, { version: now.version, replacesVersionId: future.id });
    expect([seen.status, seen.body.code]).toEqual([409, 'later_version_scheduled']);
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

  it('extra_has_rates: the pricing unit of a priced extra never changes; who takes it only changes off sale', async () => {
    const w = await pricedWorld(admin);
    const extraVersion = async (pkgId: string) => (await admin.get(`/admin/catalogue/packages/${pkgId}`)).body.extras[0].version as number;
    const patch = async (pkgId: string, body: object) => admin.patch(`/admin/catalogue/packages/${pkgId}/extras/${w.extraId}`, { ...body, version: await extraVersion(pkgId) });
    // the reviewer's case: per person at 12 000 would become per booking (or the reverse) under the same price version
    const unit = await patch(w.pkg.id, { pricingUnit: 'per_booking' });
    expect([unit.status, unit.body.code]).toEqual([409, 'extra_has_rates']);
    expect((await patch(w.pkg.id, { mandatory: true })).body.code).toBe('extra_has_rates');
    expect((await patch(w.pkg.id, { availableTo: 'runners' })).body.code).toBe('extra_has_rates');
    expect((await patch(w.pkg.id, { maxPerBooking: 3 })).status).toBe(200);
    const q = (await publicQuote(quoteBody(w, { extras: [{ extraId: w.extraId, travellerSlots: [1, 2] }] }))).body;
    expect([q.totalMinor, q.lines.filter((l: { kind: string }) => l.kind === 'extra').length]).toEqual(['156500', 2]);
    // off sale: who takes it may change; the unit still may not
    await must(setSale(admin, w.pkg.id, 'closed'), 'close');
    expect((await patch(w.pkg.id, { mandatory: true })).status).toBe(200);
    expect((await patch(w.pkg.id, { pricingUnit: 'per_booking' })).body.code).toBe('extra_has_rates');
    // an extra priced only in a draft is still free to change
    const other = await pricedWorld(admin, { open: false });
    const free = await admin.post(`/admin/catalogue/packages/${other.pkg.id}/extras`, { kind: 'meal', name: text('Pasta night'), pricingUnit: 'per_person' });
    const freeId = (free.body.extras as Array<{ id: string; version: number }>).find((e) => e.id !== other.extraId)!;
    await draftWith(admin, other.pkg.id, { ...other.rates, extraRates: [...other.rates.extraRates, { extraId: freeId.id, amountMinor: '4500' }] });
    expect((await admin.patch(`/admin/catalogue/packages/${other.pkg.id}/extras/${freeId.id}`, { pricingUnit: 'per_booking', version: freeId.version })).status).toBe(200);
  });

  it('a mandatory extra with prices in force cannot be removed while on sale; off sale, or optional, it can', async () => {
    const w = await pricedWorld(admin, { open: false });
    const added = await admin.post(`/admin/catalogue/packages/${w.pkg.id}/extras`, { kind: 'transfer', name: text('Race-day transfer'), pricingUnit: 'per_person', mandatory: true });
    const transfer = (added.body.extras as Array<{ id: string; mandatory: boolean }>).find((e) => e.mandatory)!;
    await publishWith(admin, w.pkg.id, { ...w.rates, extraRates: [...w.rates.extraRates, { extraId: transfer.id, amountMinor: '12000' }] });
    await must(setSale(admin, w.pkg.id, 'open'), 'open');
    const before = (await publicQuote(quoteBody(w))).body.totalMinor;
    expect(before).toBe('156500');
    const del = await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/extras/${transfer.id}`);
    expect([del.status, del.body.code]).toEqual([409, 'extra_has_rates']);
    expect((await publicQuote(quoteBody(w))).body.totalMinor).toBe(before);
    // an optional extra may go while on sale (it never counted unless chosen)
    expect((await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/extras/${w.extraId}`)).status).toBe(200);
    await must(setSale(admin, w.pkg.id, 'closed'), 'close');
    expect((await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/extras/${transfer.id}`)).status).toBe(200);
  });

  it('more extra nights on a package on sale need an explicit extra-night price in force', async () => {
    const w = await pricedWorld(admin, { open: false });
    const free = { ...w.rates, roomRates: w.rates.roomRates.map((r) => ({ ...r, extraNightPerPersonMinor: '0' })) };
    await publishWith(admin, w.pkg.id, free);
    await must(setSale(admin, w.pkg.id, 'open'), 'open');
    const widen = async () => admin.patch(`/admin/catalogue/packages/${w.pkg.id}`, { maxExtraNightsAfter: 2, version: (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body.version });
    const refused = await widen();
    expect([refused.status, refused.body.code]).toEqual([409, 'price_version_incomplete']);
    expect((await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body.maxExtraNightsAfter).toBe(0);
    await publishWith(admin, w.pkg.id, w.rates);
    expect((await widen()).status).toBe(200);
    expect((await publicQuote(quoteBody(w, { extraNightsAfter: 1 }))).body.totalMinor).toBe('162500');
  });

  it('a room priced only in a discarded draft can still be removed', async () => {
    const w = await pricedWorld(admin, { open: false });
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    const added = await admin.post(`/admin/catalogue/packages/${w.pkg.id}/hotels/${pkg.hotels[0].id}/rooms`, { roomType: 'single', name: text('Single'), minOccupancy: 1, maxOccupancy: 1, roomPoolId: w.roomPoolId });
    const single = (added.body.hotels[0].rooms as Array<{ id: string }>).find((r) => r.id !== w.roomId)!;
    const d = await draftWith(admin, w.pkg.id, { ...w.rates, roomRates: [...w.rates.roomRates, { roomOptionId: single.id, occupancy: 1, pricePerPersonMinor: '90000', extraNightPerPersonMinor: '30000' }] });
    expect((await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/rooms/${single.id}`)).body.code).toBe('room_has_rates');
    await must(admin.delete(`/admin/pricing/price-versions/${d.id}`), 'discard', 204);
    expect((await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/rooms/${single.id}`)).status).toBe(200);
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
    // Task 6.4: eleven cancellation policy routes join the eighteen of tasks 2.1 and 2.2.
    expect(routes().length).toBe(29);
    for (const r of routes()) {
      const method = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      expect((await t.http()[method](fill(r.path)).set(STATE_HEADERS).send({})).status, `${r.method} ${r.path}`).toBe(401);
      const denied = method === 'get' ? await nobody.get(fill(r.path)) : await nobody[method](fill(r.path), {} as never);
      expect(denied.status, `${r.method} ${r.path}`).toBe(403);
    }
  });

  it('each admin route names one pricing permission and every pricing permission is used; the quote route is public', () => {
    const used = new Set(routes().map((r) => (r.marks[0] as { key: string }).key));
    expect([...used].sort()).toEqual(Object.values(PP).sort());
    // Task 6.4: the cancellation policy a package sells under is public too (what a customer reads before booking).
    expect(allRoutes(t.app).filter((r) => r.path.startsWith('/pricing')).map((r) => r.marks[0]?.type)).toEqual(['public', 'public']);
  });
});
