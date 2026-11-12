// Price rules and promo codes through HTTP and a real PostgreSQL (plan docs/plans/2.2-pricing-rules-promo-codes.md,
// sections 3, 4, 7, 9, 11 and 15).
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PRICING_PERMISSIONS as PP, QuoteService } from '../../../src/modules/pricing';
import { price } from '../../../src/modules/pricing/engine';
import { ruleInputOf } from '../../../src/modules/pricing/adjustments';
import { engineView, loadRates } from '../../../src/modules/pricing/rates';
import { PackagePricingReader } from '../../../src/modules/catalogue';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { Client, buildWorld, closeCatalogue, packageBody, staffClient } from '../../support/catalogue';
import { createCode, createRule, freshCode, promoBody, richWorld, ruleBody } from '../../support/adjustments';
import type { RichWorld } from '../../support/adjustments';
import { must, pricedWorld, publishWith, quoteBody } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  // X-Forwarded-For counts from the loopback proxy, so each public quote can come from its own address and the
  // per-address code limit (tested on its own in promo-limit.test.ts) does not get in the way.
  t = await makeApp({ TRUST_PROXY: 'loopback' });
  admin = await staffClient(t);
});
afterAll(async () => {
  // Global rules and codes would reach later test files: archive what this file left.
  await t.prisma.$executeRawUnsafe(`UPDATE price_rules SET "archivedAt" = now(), enabled = false WHERE "archivedAt" IS NULL AND "scopeType" = 'global'`);
  await t.prisma.$executeRawUnsafe(`UPDATE promo_codes SET "archivedAt" = now(), enabled = false WHERE "archivedAt" IS NULL AND "scopeType" = 'global'`);
  await closeCatalogue(t);
});

const someIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const publicQuote = (body: object) => t.http().post('/pricing/quotes').set(STATE_HEADERS).set('X-Forwarded-For', someIp()).send(body);
const preview = (body: object) => admin.post('/admin/pricing/quotes', body);
const sql = (q: string, ...params: unknown[]) => t.prisma.$executeRawUnsafe(q, ...params);
const staleStepUp = async (c: Client & { staff: { id: string } }) =>
  t.prisma.session.updateMany({ where: { userId: c.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });

describe('rules in the panel', () => {
  let w: PricedWorld;
  beforeAll(async () => {
    w = await pricedWorld(admin);
  });
  const pkgRule = (over: Record<string, unknown> = {}) => ruleBody({ scopeType: 'package', packageId: w.pkg.id, ...over });

  it('rule_routes_require_permission_and_step_up', async () => {
    const reader = await staffClient(t, [PP.ruleRead]);
    expect((await reader.get('/admin/pricing/rules')).status).toBe(200);
    expect((await reader.post('/admin/pricing/rules', pkgRule())).status).toBe(403);
    const manager = await staffClient(t, [PP.ruleRead, PP.ruleManage]);
    await staleStepUp(manager);
    const stale = await manager.post('/admin/pricing/rules', pkgRule());
    expect([stale.status, stale.body.code]).toEqual([403, 'step_up_required']);
    expect((await admin.post('/admin/pricing/rules', pkgRule({ enabled: false }))).status).toBe(201);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an early bird without a date or days', { kind: 'early_bird' }, 'rule_invalid'],
    ['a late supplement without days', { kind: 'late_supplement', direction: 'surcharge' }, 'rule_invalid'],
    ['a group discount without a minimum', { kind: 'group_discount' }, 'rule_invalid'],
    ['an occupancy supplement without occupancies', { kind: 'occupancy_supplement', direction: 'surcharge' }, 'rule_invalid'],
    ['a percentage per person', { per: 'person' }, 'rule_invalid'],
    ['a discount above 100 %', { valueBps: 10_001 }, 'rule_invalid'],
    ['a fixed amount without its currency', { effectMode: 'fixed', valueBps: null, valueMinor: '5000' }, 'rule_invalid'],
    ['percent and fixed at once', { valueMinor: '5000', currency: 'AUD' }, 'rule_invalid'],
    ['a fixed amount per person above A$12 500', { effectMode: 'fixed', valueBps: null, valueMinor: '1250001', currency: 'AUD', per: 'person' }, 'rule_invalid'],
    ['a fixed amount per booking above A$1 000 000', { effectMode: 'fixed', valueBps: null, valueMinor: '100000001', currency: 'AUD' }, 'validation_failed'],
    ['a condition the schema does not know', { conditions: { birthday: '2027-01-01' } }, 'validation_failed'],
    ['empty occupancies', { conditions: { occupancies: [] } }, 'validation_failed'],
    ['more travellers at least than at most', { conditions: { minTravellers: 4, maxTravellers: 2 } }, 'rule_invalid'],
    ['an end before the start', { validFrom: '2027-02-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' }, 'validity_invalid'],
    ['a currency the catalogue does not sell in', { effectMode: 'fixed', valueBps: null, valueMinor: '5000', currency: 'NZD' }, 'validation_failed'],
    ['a package rule without its package', { packageId: null }, 'scope_invalid'],
    ['a global rule that names a package', { scopeType: 'global' }, 'scope_invalid'],
  ])('rule_saved_invalid_rejected: %s → 422 %s', async (_n, over, code) => {
    const res = await admin.post('/admin/pricing/rules', pkgRule(over));
    expect([res.status, res.body.code]).toEqual([422, code]);
  });

  it('rule_currency_must_match_scope: the database refuses a fixed amount in another currency than its package or edition', async () => {
    const base = `INSERT INTO price_rules (id, label, "scopeType", "editionId", "packageId", kind, direction, "effectMode", "valueMinor", currency, per, "appliesTo", priority, enabled, "updatedAt")
      VALUES ($1::uuid, 'x', $2::"PriceRuleScope", $3::uuid, $4::uuid, 'custom', 'discount', 'fixed', 5000, 'NZD', 'booking', 'subtotal', 1, false, now())`;
    await expect(sql(base, crypto.randomUUID(), 'package', null, w.pkg.id)).rejects.toThrow(/currency of its package/);
    await expect(sql(base, crypto.randomUUID(), 'edition', w.edition.id, null)).rejects.toThrow(/every package of its edition/);
    await expect(sql(base.replace("'NZD'", "'AUD'"), crypto.randomUUID(), 'package', null, w.pkg.id)).resolves.toBe(1);
    await sql(`UPDATE price_rules SET "archivedAt" = now() WHERE "packageId" = $1::uuid AND label = 'x'`, w.pkg.id);
  });

  it('rule_changes_audited_before_after and rule_version_conflict_409', async () => {
    const r = await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, enabled: false });
    const edit = (version: number, valueBps: number) => admin.patch(`/admin/pricing/rules/${r.id}`, { ...pkgRule({ enabled: false, valueBps }), scopeType: undefined, packageId: undefined, version, reason: 'Hotel deal' });
    const first = await edit(0, 2000);
    expect([first.status, first.body.version, first.body.valueBps]).toEqual([200, 1, 2000]);
    const stale = await edit(0, 3000);
    expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
    const created = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'pricing.rule.created', entityId: r.id } });
    expect(created.changes).toMatchObject({ valueBps: { before: null, after: 1000 } });
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'pricing.rule.updated', entityId: r.id } });
    expect(log.changes).toMatchObject({ valueBps: { before: 1000, after: 2000 }, _reason: '[pii]' });
  });

  it('archived_rule_not_applied_and_frozen', async () => {
    const own = await pricedWorld(admin);
    const r = await createRule(admin, { scopeType: 'package', packageId: own.pkg.id, valueBps: 1000 });
    // 10 % of the double room for two (100 000)
    expect((await publicQuote(quoteBody(own))).body.totalMinor).toBe('122500');
    const archived = await must(admin.post(`/admin/pricing/rules/${r.id}/archive`, { version: r.version, reason: 'Ended' }), 'archive');
    expect([archived.body.enabled, archived.body.archivedAt === null]).toEqual([false, false]);
    expect((await publicQuote(quoteBody(own))).body.totalMinor).toBe('132500');
    const edit = await admin.patch(`/admin/pricing/rules/${r.id}`, { ...pkgRule(), scopeType: undefined, packageId: undefined, version: archived.body.version });
    expect([edit.status, edit.body.code]).toEqual([409, 'rule_archived']);
    await expect(sql(`UPDATE price_rules SET enabled = true WHERE id = $1::uuid`, r.id)).rejects.toThrow(/archived rule or code never changes/);
  });

  it('rule_rows_never_deleted: no DELETE, no TRUNCATE; the scope never changes', async () => {
    const r = await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, enabled: false });
    await expect(sql(`DELETE FROM price_rules WHERE id = $1::uuid`, r.id)).rejects.toThrow(/archived, never deleted/);
    await expect(sql(`TRUNCATE price_rules`)).rejects.toThrow(/append-only|permission denied|must be owner/);
    await expect(sql(`UPDATE price_rules SET "scopeType" = 'global', "packageId" = NULL WHERE id = $1::uuid`, r.id)).rejects.toThrow(/scope of a rule or code never changes/);
  });

  it('rule_limit_per_scope_concurrent: 49 rules, three creations at once, one passes', async () => {
    const own = await buildWorld(admin, { priced: false });
    for (let i = 0; i < 49; i++) {
      await sql(`INSERT INTO price_rules (id, label, "scopeType", "packageId", kind, direction, "effectMode", "valueBps", per, "appliesTo", priority, enabled, "updatedAt")
        VALUES ($1::uuid, 'Filler', 'package', $2::uuid, 'custom', 'discount', 'percent', 0, 'booking', 'extras', 1, false, now())`, crypto.randomUUID(), own.pkg.id);
    }
    const three = await Promise.all([1, 2, 3].map(() => admin.post('/admin/pricing/rules', ruleBody({ scopeType: 'package', packageId: own.pkg.id, enabled: false }))));
    expect(three.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(three.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(['rule_limit_reached', 'rule_limit_reached']);
    expect(await t.prisma.priceRule.count({ where: { packageId: own.pkg.id, archivedAt: null } })).toBe(50);
  });

  it('quote_fails_when_rule_cap_exceeded: 151 rules reach a quote (the limit bypassed in SQL) → 500, never some of them', async () => {
    const own = await pricedWorld(admin);
    for (let i = 0; i < 151; i++) {
      await sql(`INSERT INTO price_rules (id, label, "scopeType", "packageId", kind, direction, "effectMode", "valueBps", per, "appliesTo", priority, enabled, "updatedAt")
        VALUES ($1::uuid, 'Filler', 'package', $2::uuid, 'custom', 'discount', 'percent', 0, 'booking', 'extras', 1, false, now())`, crypto.randomUUID(), own.pkg.id);
    }
    const res = await publicQuote(quoteBody(own));
    expect([res.status, res.body.code]).toEqual([500, 'unexpected_error']);
    await sql(`UPDATE price_rules SET "archivedAt" = now() WHERE "packageId" = $1::uuid AND "archivedAt" IS NULL`, own.pkg.id);
    expect((await publicQuote(quoteBody(own))).status).toBe(200);
  });

  it('stored_rule_invalid_is_500_not_422: a rule the engine refuses, put in by SQL, is the API’s fault', async () => {
    const own = await pricedWorld(admin);
    await sql(`INSERT INTO price_rules (id, label, "scopeType", "packageId", kind, direction, conditions, "effectMode", "valueBps", per, "appliesTo", priority, enabled, "updatedAt")
      VALUES ($1::uuid, 'Broken', 'package', $2::uuid, 'early_bird', 'discount', '{}', 'percent', 1000, 'booking', 'accommodation', 1, true, now())`, crypto.randomUUID(), own.pkg.id);
    for (const res of [await publicQuote(quoteBody(own)), await preview(quoteBody(own))]) expect([res.status, res.body.code]).toEqual([500, 'unexpected_error']);
    await sql(`UPDATE price_rules SET "archivedAt" = now() WHERE "packageId" = $1::uuid AND "archivedAt" IS NULL`, own.pkg.id);
    await sql(`INSERT INTO price_rules (id, label, "scopeType", "packageId", kind, direction, conditions, "effectMode", "valueBps", per, "appliesTo", priority, enabled, "updatedAt")
      VALUES ($1::uuid, 'Broken JSON', 'package', $2::uuid, 'custom', 'discount', '{"birthday": "2027-01-01"}', 'percent', 1000, 'booking', 'accommodation', 1, true, now())`, crypto.randomUUID(), own.pkg.id);
    expect((await publicQuote(quoteBody(own))).status).toBe(500);
    await sql(`UPDATE price_rules SET "archivedAt" = now() WHERE "packageId" = $1::uuid AND "archivedAt" IS NULL`, own.pkg.id);
  });

  it('stored_rule_line_above_limit_not_422: a 1 000 % surcharge on A$800 000 of rooms is a 409 for the configuration', async () => {
    const own = await pricedWorld(admin);
    await publishWith(admin, own.pkg.id, { ...own.rates, roomRates: own.rates.roomRates.map((r) => ({ ...r, pricePerPersonMinor: '40000000' })) });
    await createRule(admin, { scopeType: 'package', packageId: own.pkg.id, direction: 'surcharge', valueBps: 100_000 });
    for (const res of [await publicQuote(quoteBody(own)), await preview(quoteBody(own))]) expect([res.status, res.body.code]).toEqual([409, 'adjustment_above_limit']);
  });
});

describe('persisted_rules_priced_like_engine', () => {
  let w: RichWorld;
  beforeAll(async () => {
    w = await richWorld(admin);
  });
  const M = (w2: RichWorld) => ({ participationType: 'runner_with_entry', raceDistanceId: w2.distanceId });
  const S = { participationType: 'supporter' };
  const body = (room: 'double' | 'quad', travellers: object[], over: Record<string, unknown> = {}) =>
    ({ packageId: w.pkg.id, rooms: [{ roomOptionId: room === 'double' ? w.doubleId : w.quadId, travellers }], ...over });

  /** The engine itself, on the rows as stored and the rates in force, for the same request. */
  async function engineTotal(req: ReturnType<typeof body>): Promise<string> {
    return t.prisma.$transaction(async (tx) => {
      const view = (await t.app.get(PackagePricingReader).load(tx, w.pkg.id))!;
      const v = await tx.priceVersion.findFirstOrThrow({ where: { packageId: w.pkg.id, status: 'published', validTo: null } });
      const rates = await loadRates(tx, v.id, v.currency);
      const rows = await tx.priceRule.findMany({ where: { archivedAt: null, OR: [{ scopeType: 'global' }, { packageId: w.pkg.id }, { editionId: w.edition.id }] }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
      const r = req as unknown as { rooms: Array<{ roomOptionId: string; travellers: never[] }>; extraNightsAfter?: number };
      return price({ rooms: r.rooms, extraNightsBefore: 0, extraNightsAfter: r.extraNightsAfter ?? 0, extras: [] }, engineView(view), rates, rows.map(ruleInputOf), null, new Date()).totalMinor.toString();
    });
  }

  const rows = (): Array<[string, ReturnType<typeof body>]> => [
    ['quad at 1', body('quad', [M(w)])],
    ['quad at 2', body('quad', [M(w), M(w)])],
    ['quad at 3', body('quad', [M(w), M(w), M(w)])],
    ['quad at 4', body('quad', [M(w), M(w), M(w), M(w)])],
    ['double at 1, 2 extra nights', body('double', [M(w)], { extraNightsAfter: 2 })],
    ['double at 2, runner and supporter', body('double', [M(w), S])],
    ['quad at 3, runner and two supporters, 1 extra night', body('quad', [M(w), S, S], { extraNightsAfter: 1 })],
  ];

  it.each([false, true])('stackable = %s: early bird (package), group discount (edition), single supplement and supporter discount (package)', async (stackable) => {
    const created = [
      await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, kind: 'early_bird', appliesTo: 'accommodation', priority: 1, stackable, conditions: { bookedOnOrBefore: '2099-12-31' } }),
      await createRule(admin, { scopeType: 'edition', editionId: w.edition.id, kind: 'group_discount', appliesTo: 'subtotal', priority: 2, stackable, valueBps: 500, conditions: { minTravellers: 3 } }),
      await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, kind: 'occupancy_supplement', direction: 'surcharge', appliesTo: 'accommodation', priority: 1, stackable, conditions: { occupancies: [1] }, effectMode: 'fixed', valueBps: null, valueMinor: '10000', currency: 'AUD', per: 'person' }),
      await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, appliesTo: 'participation', priority: 3, stackable, valueBps: 5000, conditions: { participationTypes: ['supporter'] } }),
    ];
    for (const [name, req] of rows()) {
      const [pub, panel] = [await publicQuote(req), await preview(req)];
      expect([pub.status, panel.status], name).toEqual([200, 200]);
      expect(pub.body.totalMinor, name).toBe(await engineTotal(req));
      expect(panel.body.totalMinor, name).toBe(pub.body.totalMinor);
    }
    // two rows by hand: quad at 4 = 4 × 35 000 + 4 × 30 000 = 260 000, early bird 14 000, group 5 % of 260 000 = 13 000
    // (not stackable: the group discount overlaps the early bird and is blocked); quad at 1 = 120 000 + 10 000 − 9 000
    expect((await publicQuote(rows()[3]![1])).body.totalMinor).toBe(stackable ? '233000' : '246000');
    expect((await publicQuote(rows()[0]![1])).body.totalMinor).toBe('121000');
    for (const r of created) await must(admin.post(`/admin/pricing/rules/${r.id}/archive`, { version: r.version }), 'archive');
  });

  it('a disabled rule or one outside its validity does nothing; the panel trace says why', async () => {
    const off = await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, enabled: false });
    const later = await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, validFrom: '2099-01-01T00:00:00Z' });
    const res = await preview(body('quad', [M(w)]));
    expect(res.body.totalMinor).toBe('120000');
    expect(res.body.trace).toEqual(expect.arrayContaining([{ ruleId: off.id, outcome: 'disabled' }, { ruleId: later.id, outcome: 'out_of_validity' }]));
    for (const r of [off, later]) await must(admin.post(`/admin/pricing/rules/${r.id}/archive`, { version: r.version }), 'archive');
  });
});

describe('promo codes', () => {
  let w: PricedWorld;
  beforeAll(async () => {
    w = await pricedWorld(admin);
  });
  const withCode = (code: string, over: Record<string, unknown> = {}) => quoteBody(w, { promoCode: code, ...over });

  it('promo_routes_require_permission_and_step_up', async () => {
    const reader = await staffClient(t, [PP.promoCodeRead]);
    expect((await reader.get('/admin/pricing/promo-codes')).status).toBe(200);
    expect((await reader.post('/admin/pricing/promo-codes', promoBody(freshCode()))).status).toBe(403);
    const manager = await staffClient(t, [PP.promoCodeRead, PP.promoCodeManage]);
    await staleStepUp(manager);
    const stale = await manager.post('/admin/pricing/promo-codes', promoBody(freshCode()));
    expect([stale.status, stale.body.code]).toEqual([403, 'step_up_required']);
  });

  it('promo_code_normalised_and_unique_ci: stored upper case, compared without case, never reused', async () => {
    const raw = freshCode('summer-');
    const c = await createCode(admin, `  ${raw.toLowerCase()} `, { scopeType: 'package', packageId: w.pkg.id });
    expect(c.code).toBe(raw.toUpperCase());
    const again = await admin.post('/admin/pricing/promo-codes', promoBody(raw.toLowerCase(), { scopeType: 'package', packageId: w.pkg.id }));
    expect([again.status, again.body.code]).toEqual([409, 'promo_code_taken']);
    const applied = await publicQuote(withCode(`${raw.toLowerCase()} `));
    expect([applied.body.promo.status, applied.body.totalMinor]).toEqual(['applied', '119250']);
    await must(admin.post(`/admin/pricing/promo-codes/${c.id}/archive`, { version: c.version }), 'archive');
    expect((await admin.post('/admin/pricing/promo-codes', promoBody(raw))).body.code).toBe('promo_code_taken');
    expect((await publicQuote(withCode(raw))).body.promo.status).toBe('invalid');
    for (const bad of ['AB', 'A B C D E F', '-ABCDEF', 'ABCDEF-', 'ÁBCDEF']) expect((await admin.post('/admin/pricing/promo-codes', promoBody(bad))).status, bad).toBe(422);
  });

  it('promo_code_text_immutable: the text and the scope never change, in SQL either', async () => {
    const c = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, enabled: false });
    await expect(sql(`UPDATE promo_codes SET code = 'CHANGED1' WHERE id = $1::uuid`, c.id)).rejects.toThrow(/text of a promo code never changes/);
    await expect(sql(`UPDATE promo_codes SET "scopeType" = 'global', "packageId" = NULL WHERE id = $1::uuid`, c.id)).rejects.toThrow(/scope of a rule or code never changes/);
    await expect(sql(`DELETE FROM promo_codes WHERE id = $1::uuid`, c.id)).rejects.toThrow(/archived, never deleted/);
  });

  it('promo_max_below_redeemed_rejected: 409 from the API, and the CHECK refuses it in SQL', async () => {
    const c = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, maxRedemptions: 5 });
    await sql(`UPDATE promo_codes SET "redeemedCount" = 3 WHERE id = $1::uuid`, c.id);
    const res = await admin.patch(`/admin/pricing/promo-codes/${c.id}`, { ...promoBody('X'), code: undefined, scopeType: undefined, maxRedemptions: 2, version: c.version });
    expect([res.status, res.body.code]).toEqual([409, 'max_below_redeemed']);
    await expect(sql(`UPDATE promo_codes SET "maxRedemptions" = 2 WHERE id = $1::uuid`, c.id)).rejects.toThrow(/promo_codes_redeemed_check/);
    const ok = await admin.patch(`/admin/pricing/promo-codes/${c.id}`, { ...promoBody('X'), code: undefined, scopeType: undefined, maxRedemptions: 3, version: c.version });
    expect([ok.status, ok.body.maxRedemptions, ok.body.redeemedCount]).toEqual([200, 3, 3]);
  });

  it('exhausted_or_expired_code_invalid_in_quote: in the panel too', async () => {
    const pkgCode = (over: Record<string, unknown>) => createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, ...over });
    const exhausted = await pkgCode({ maxRedemptions: 1 });
    await sql(`UPDATE promo_codes SET "redeemedCount" = 1 WHERE id = $1::uuid`, exhausted.id);
    const codes = [
      exhausted,
      await pkgCode({ validTo: new Date(Date.now() - 60_000).toISOString(), validFrom: new Date(Date.now() - 3_600_000).toISOString() }),
      await pkgCode({ validFrom: new Date(Date.now() + 3_600_000).toISOString() }),
      await pkgCode({ enabled: false }),
    ];
    for (const c of codes) {
      expect((await preview(withCode(c.code))).body.promo.status, c.code).toBe('invalid');
      expect((await publicQuote(withCode(c.code))).body.promo.status, c.code).toBe('invalid');
    }
  });

  it('admin_preview_shows_real_promo_status, public_promo_status_never_reveals_existence', async () => {
    const rule = await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, appliesTo: 'subtotal', stackable: false });
    const other = await pricedWorld(admin);
    const exhausted = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, maxRedemptions: 1 });
    await sql(`UPDATE promo_codes SET "redeemedCount" = 1 WHERE id = $1::uuid`, exhausted.id);
    const cases: Array<[string, string, string]> = [
      ['unknown', freshCode('NOPE'), 'invalid'],
      ['disabled', (await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, enabled: false })).code, 'invalid'],
      ['expired', (await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, validFrom: new Date(Date.now() - 7_200_000).toISOString(), validTo: new Date(Date.now() - 3_600_000).toISOString() })).code, 'invalid'],
      ['not yet valid', (await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, validFrom: new Date(Date.now() + 3_600_000).toISOString() })).code, 'invalid'],
      ['exhausted', exhausted.code, 'invalid'],
      ['another package', (await createCode(admin, freshCode(), { scopeType: 'package', packageId: other.pkg.id })).code, 'invalid'],
      ['conditions not met', (await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, conditions: { minTravellers: 3 } })).code, 'conditions_not_met'],
      ['filter matching nobody', (await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, conditions: { occupancies: [1] } })).code, 'conditions_not_met'],
      ['not combinable', (await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, appliesTo: 'accommodation' })).code, 'not_combinable'],
      ['badly formed', 'x!', 'invalid'],
    ];
    const strip = (b: Record<string, unknown>): Record<string, unknown> => ({ ...b, computedAt: undefined });
    const none = strip((await publicQuote(quoteBody(w))).body);
    expect(none.promo).toEqual({ status: 'none' });
    for (const [name, code, real] of cases) {
      const pub = await publicQuote(withCode(code));
      expect(pub.status, name).toBe(200);
      expect(strip(pub.body), name).toEqual({ ...none, promo: { status: 'invalid' } });
      const panel = await preview(withCode(code));
      expect(panel.body.promo.status, name).toBe(real);
    }
    await must(admin.post(`/admin/pricing/rules/${rule.id}/archive`, { version: rule.version }), 'archive');
  });

  it('public_promo_config_error_reads_invalid: a code the engine refuses reads invalid to the public, 409 in the panel', async () => {
    const insert = (code: string, conditions: string) => sql(`INSERT INTO promo_codes (id, code, label, "scopeType", "packageId", conditions, "effectMode", "valueBps", per, "appliesTo", enabled, "updatedAt")
      VALUES ($1::uuid, $2, 'Broken', 'package', $3::uuid, $4::jsonb, 'percent', 1000, 'booking', 'subtotal', true, now())`, crypto.randomUUID(), code, w.pkg.id, conditions);
    const empty = freshCode();
    const unknown = freshCode();
    await insert(empty, '{"occupancies": []}');
    await insert(unknown, '{"birthday": "2027-01-01"}');
    for (const code of [empty, unknown]) {
      const pub = await publicQuote(withCode(code));
      expect([pub.status, pub.body.promo, pub.body.totalMinor], code).toEqual([200, { status: 'invalid' }, '132500']);
      const panel = await preview(withCode(code));
      expect([panel.status, panel.body.code], code).toEqual([409, 'promo_code_misconfigured']);
    }
  });

  it('promo code validity at the millisecond: validFrom included, validTo excluded (boundary_dates)', async () => {
    const from = new Date(Date.now() + 3_600_000);
    const to = new Date(from.getTime() + 3_600_000);
    const c = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, validFrom: from.toISOString(), validTo: to.toISOString() });
    const quotes = t.app.get(QuoteService);
    const req = { ...withCode(c.code), extraNightsBefore: 0, extraNightsAfter: 0, extras: [] };
    const at = (now: Date) => t.prisma.$transaction((tx) => quotes.priceIn(tx, req as never, { audience: 'staff', now }));
    expect((await at(new Date(from.getTime() - 1))).promo.status).toBe('invalid');
    expect((await at(from)).promo.status).toBe('applied');
    expect((await at(new Date(to.getTime() - 1))).promo.status).toBe('applied');
    expect((await at(to)).promo.status).toBe('invalid');
  });
});

describe('catalogue: deposit_schema_rejects_non_numeric_with_422', () => {
  it('a deposit amount that is not a whole number is a 422, not a 500', async () => {
    const w = await buildWorld(admin, { priced: false });
    for (const amountMinor of ['1.5', 'abc', '-1', '']) {
      const res = await admin.post(`/admin/catalogue/editions/${w.edition.id}/packages`, packageBody({ deposit: { mode: 'per_person', amountMinor } }));
      expect(res.status, amountMinor).toBe(422);
    }
  });
});
