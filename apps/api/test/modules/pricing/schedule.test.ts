// Scheduled price versions, withdrawal and the price terms a version is published with (plan
// docs/plans/2.2-pricing-rules-promo-codes.md, sections 5, 6 and 15, points 4 and 5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PRICING_PERMISSIONS as PP, QuoteService } from '../../../src/modules/pricing';
import { versionInForce } from '../../../src/modules/pricing/rates';
import { TestApp, makeApp } from '../../support/auth';
import { Client, buildWorld, closeCatalogue, setSale, staffClient } from '../../support/catalogue';
import { cardFor, currentOf, draftWith, lastOf, must, pricedWorld, publishWith, quoteBody } from '../../support/pricing';
import type { PricedWorld, RatesBody } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t);
});
afterAll(async () => {
  await closeCatalogue(t);
});

const sql = (q: string, ...params: unknown[]) => t.prisma.$executeRawUnsafe(q, ...params);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const dearer = (r: RatesBody, by: bigint): RatesBody => ({ ...r, roomRates: r.roomRates.map((x) => ({ ...x, pricePerPersonMinor: String(BigInt(x.pricePerPersonMinor) + by) })) });
const schedule = async (w: PricedWorld, rates: RatesBody, validFrom: string, replacesVersionId?: string | null) => {
  const d = await draftWith(admin, w.pkg.id, rates, `From ${validFrom}`);
  const res = await admin.post(`/admin/pricing/price-versions/${d.id}/publish`, { version: d.version, replacesVersionId: replacesVersionId === undefined ? await lastOf(admin, w.pkg.id) : replacesVersionId, validFrom });
  return { ...d, res };
};
const withdraw = async (id: string) => {
  const v = (await admin.get(`/admin/pricing/price-versions/${id}`)).body;
  return admin.post(`/admin/pricing/price-versions/${id}/withdraw`, { version: v.version, reason: 'Changed our mind' });
};
const row = (id: string) => t.prisma.priceVersion.findUniqueOrThrow({ where: { id } });

describe('scheduling', () => {
  it('schedule_future_version_switches_at_valid_from: the old prices until the instant, the new ones from it', async () => {
    const w = await pricedWorld(admin);
    const at = inHours(1);
    const s = await schedule(w, dearer(w.rates, 1000n), at);
    expect(s.res.status).toBe(200);
    const start = new Date(at);
    expect([(await row(w.versionId)).validTo?.getTime(), (await row(s.id)).validFrom?.getTime()]).toEqual([start.getTime(), start.getTime()]);
    expect([await currentOf(admin, w.pkg.id), await lastOf(admin, w.pkg.id)]).toEqual([w.versionId, s.id]);
    const quotes = t.app.get(QuoteService);
    const req = { ...quoteBody(w), extraNightsBefore: 0, extraNightsAfter: 0, extras: [] } as never;
    const at2 = (now: Date) => t.prisma.$transaction((tx) => quotes.priceIn(tx, req, { audience: 'public', now }));
    const before = await at2(new Date(start.getTime() - 1));
    const after = await at2(start);
    expect([before.priceVersionId, before.totalMinor, after.priceVersionId, after.totalMinor]).toEqual([w.versionId, 132_500n, s.id, 134_500n]);
    expect((await versionInForce(t.prisma, w.pkg.id, new Date()))!.id).toBe(w.versionId);
    const event = await t.prisma.outboxEvent.findFirstOrThrow({ where: { type: 'pricing.price_version.published', aggregateId: s.id } });
    expect(event.payload).toMatchObject({ previousVersionId: w.versionId, validFrom: start.toISOString() });
  });

  it('schedule_in_past_rejected', async () => {
    const w = await pricedWorld(admin);
    const s = await schedule(w, w.rates, new Date(Date.now() - 60_000).toISOString());
    expect([s.res.status, s.res.body.code]).toEqual([422, 'price_version_start_in_past']);
  });

  it('schedule_before_last_scheduled_rejected; after it, the chain grows at the end', async () => {
    const w = await pricedWorld(admin);
    const two = await schedule(w, w.rates, inHours(2));
    expect(two.res.status).toBe(200);
    const one = await schedule(w, w.rates, inHours(1), two.id);
    expect([one.res.status, one.res.body.code]).toEqual([409, 'later_version_scheduled']);
    const blind = await schedule(w, w.rates, inHours(3), w.versionId);
    expect([blind.res.status, blind.res.body.code]).toEqual([409, 'current_version_changed']);
    const three = await schedule(w, w.rates, inHours(3), two.id);
    expect(three.res.status).toBe(200);
    expect((await row(two.id)).validTo?.toISOString()).toBe((await row(three.id)).validFrom?.toISOString());
  });

  it('concurrent_schedule_one_wins', async () => {
    const w = await pricedWorld(admin);
    const [a, b] = [await draftWith(admin, w.pkg.id, w.rates, 'A'), await draftWith(admin, w.pkg.id, w.rates, 'B')];
    const two = await Promise.all([[a, inHours(1)], [b, inHours(2)]].map(([d, at]) =>
      admin.post(`/admin/pricing/price-versions/${(d as { id: string }).id}/publish`, { version: (d as { version: number }).version, replacesVersionId: w.versionId, validFrom: at })));
    expect(two.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.prisma.priceVersion.count({ where: { packageId: w.pkg.id, status: 'published' } })).toBe(2);
  });

  it('schedule_requires_complete_version_and_step_up', async () => {
    const w = await pricedWorld(admin);
    const partial = await schedule(w, { ...w.rates, extraRates: [] }, inHours(1));
    expect([partial.res.status, partial.res.body.code]).toEqual([409, 'price_version_incomplete']);
    const publisher = await staffClient(t, [PP.versionRead, PP.versionManage, PP.versionPublish]);
    const d = await draftWith(publisher, w.pkg.id, w.rates);
    await t.prisma.session.updateMany({ where: { userId: publisher.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const stale = await publisher.post(`/admin/pricing/price-versions/${d.id}/publish`, { version: d.version, replacesVersionId: w.versionId, validFrom: inHours(1) });
    expect([stale.status, stale.body.code]).toEqual([403, 'step_up_required']);
  });
});

describe('withdrawing', () => {
  it('withdraw_scheduled_version_reopens_predecessor: audited, with its event; quotes after the instant keep the old prices', async () => {
    const w = await pricedWorld(admin);
    const at = inHours(1);
    const s = await schedule(w, dearer(w.rates, 1000n), at);
    const res = await withdraw(s.id);
    expect([res.status, res.body.status, res.body.validFrom]).toEqual([200, 'archived', new Date(at).toISOString()]);
    expect((await row(w.versionId)).validTo).toBeNull();
    expect((await versionInForce(t.prisma, w.pkg.id, new Date(Date.parse(at) + 1)))!.id).toBe(w.versionId);
    expect([await currentOf(admin, w.pkg.id), await lastOf(admin, w.pkg.id)]).toEqual([w.versionId, w.versionId]);
    expect(await t.prisma.auditLog.count({ where: { action: 'pricing.price_version.withdrawn', entityId: s.id } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { action: 'pricing.price_version.reopened', entityId: w.versionId } })).toBe(1);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'pricing.price_version.withdrawn', aggregateId: s.id } })).toBe(1);
    // and a new one can be scheduled in its place
    expect((await schedule(w, w.rates, inHours(1))).res.status).toBe(200);
  });

  it('withdraw_only_last_and_not_too_soon; never a draft, never the version in force; needs step-up', async () => {
    const w = await pricedWorld(admin);
    const a = await schedule(w, w.rates, inHours(1));
    const b = await schedule(w, w.rates, inHours(2));
    expect((await withdraw(a.id)).body.code).toBe('price_version_not_last');
    expect((await withdraw(b.id)).status).toBe(200);
    expect((await withdraw(a.id)).status).toBe(200);
    expect((await withdraw(w.versionId)).body.code).toBe('price_version_starts_too_soon');
    const soon = await schedule(w, w.rates, new Date(Date.now() + 4 * 60_000).toISOString());
    expect((await withdraw(soon.id)).body.code).toBe('price_version_starts_too_soon');
    const d = await draftWith(admin, w.pkg.id, w.rates);
    expect((await admin.post(`/admin/pricing/price-versions/${d.id}/withdraw`, { version: d.version })).body.code).toBe('price_version_not_scheduled');
    const later = await schedule(w, w.rates, inHours(5));
    const publisher = await staffClient(t, [PP.versionRead, PP.versionPublish]);
    await t.prisma.session.updateMany({ where: { userId: publisher.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const v = (await admin.get(`/admin/pricing/price-versions/${later.id}`)).body;
    expect((await publisher.post(`/admin/pricing/price-versions/${later.id}/withdraw`, { version: v.version })).body.code).toBe('step_up_required');
  });

  it('withdraw_started_version_rejected_by_sql, and a withdrawal that leaves the predecessor closed is refused at commit', async () => {
    const w = await pricedWorld(admin);
    await expect(sql(`UPDATE price_versions SET status = 'archived' WHERE id = $1::uuid`, w.versionId)).rejects.toThrow(/frozen once it has started/);
    const s = await schedule(w, w.rates, inHours(1));
    await expect(sql(`UPDATE price_versions SET status = 'archived' WHERE id = $1::uuid`, s.id)).rejects.toThrow(/leaves its predecessor ending without a successor/);
    expect((await row(s.id)).status).toBe('published');
  });

  it('withdraw_trigger_uses_clock_not_tx_start: a version that starts during the transaction can no longer be withdrawn', async () => {
    const w = await buildWorld(admin, { priced: false });
    const d = await draftWith(admin, w.pkg.id, { roomRates: [], participationRates: [], extraRates: [] });
    await sql(`UPDATE price_versions SET status = 'published', "validFrom" = clock_timestamp() + interval '1500 milliseconds', "publishedAt" = now(), "pricedTerms" = '[]' WHERE id = $1::uuid`, d.id);
    const attempt = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT now()`; // the transaction's now() is fixed here, before the version starts
      await tx.$queryRaw`SELECT pg_sleep(2)::text`;
      await tx.$executeRaw`UPDATE price_versions SET status = 'archived' WHERE id = ${d.id}::uuid`;
    }, { timeout: 10_000 });
    await expect(attempt).rejects.toThrow(/frozen once it has started/);
    // control: one that starts a minute later is withdrawn in the same way
    const other = await buildWorld(admin, { priced: false });
    const f = await draftWith(admin, other.pkg.id, { roomRates: [], participationRates: [], extraRates: [] });
    await sql(`UPDATE price_versions SET status = 'published', "validFrom" = clock_timestamp() + interval '60 seconds', "publishedAt" = now(), "pricedTerms" = '[]' WHERE id = $1::uuid`, f.id);
    await t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_sleep(1)::text`;
      await tx.$executeRaw`UPDATE price_versions SET status = 'archived' WHERE id = ${f.id}::uuid`;
    }, { timeout: 10_000 });
    expect((await row(f.id)).status).toBe('archived');
  });
});

describe('price terms (plan 2.2, section 6)', () => {
  const extraOf = async (pkgId: string) => (await admin.get(`/admin/catalogue/packages/${pkgId}`)).body.extras[0] as { id: string; version: number };
  const patchExtra = async (pkgId: string, body: object) => {
    const e = await extraOf(pkgId);
    return admin.patch(`/admin/catalogue/packages/${pkgId}/extras/${e.id}`, { ...body, version: e.version });
  };

  it('priced_terms_frozen_on_publish: a version stores the extras’ terms and never changes them', async () => {
    const w = await pricedWorld(admin);
    expect((await row(w.versionId)).pricedTerms).toEqual([{ extraId: w.extraId, pricingUnit: 'per_person', mandatory: false, availableTo: null }]);
    await expect(sql(`UPDATE price_versions SET "pricedTerms" = '[]' WHERE id = $1::uuid`, w.versionId)).rejects.toThrow(/frozen/);
  });

  it.each<[string, (w: PricedWorld) => Promise<unknown>]>([
    ['made mandatory', (w) => patchExtra(w.pkg.id, { mandatory: true })],
    ['made mandatory for runners only', async (w) => patchExtra(w.pkg.id, { mandatory: true, availableTo: 'runners' })],
  ])('reopen_after_extra_terms_change_requires_new_version: an extra %s while closed', async (_n, change) => {
    const w = await pricedWorld(admin);
    await must(setSale(admin, w.pkg.id, 'closed'), 'close');
    await must(change(w) as Promise<{ status: number; body: unknown }>, 'change');
    const refused = await setSale(admin, w.pkg.id, 'open');
    expect([refused.status, refused.body.code]).toEqual([409, 'price_terms_changed']);
    await publishWith(admin, w.pkg.id, w.rates, 'For the new terms');
    expect((await setSale(admin, w.pkg.id, 'open')).status).toBe(200);
  });

  it('reopen_after_extra_terms_change_requires_new_version: who must take a mandatory extra, or removing it, while closed', async () => {
    const w = await pricedWorld(admin, { open: false });
    await must(patchExtra(w.pkg.id, { mandatory: true }), 'mandatory');
    await publishWith(admin, w.pkg.id, w.rates, 'Mandatory tour');
    await must(setSale(admin, w.pkg.id, 'open'), 'open');
    const total = (await admin.post('/admin/pricing/quotes', quoteBody(w))).body.totalMinor;
    expect(total).toBe('156500');
    await must(setSale(admin, w.pkg.id, 'closed'), 'close');
    await must(patchExtra(w.pkg.id, { availableTo: 'supporters' }), 'supporters only');
    expect((await setSale(admin, w.pkg.id, 'open')).body.code).toBe('price_terms_changed');
    await must(patchExtra(w.pkg.id, { availableTo: 'all' }), 'back to everyone');
    expect((await setSale(admin, w.pkg.id, 'open')).status).toBe(200);
    await must(setSale(admin, w.pkg.id, 'closed'), 'close again');
    await must(admin.delete(`/admin/catalogue/packages/${w.pkg.id}/extras/${w.extraId}`), 'remove the mandatory extra');
    expect((await setSale(admin, w.pkg.id, 'open')).body.code).toBe('price_terms_changed');
    await publishWith(admin, w.pkg.id, { ...w.rates, extraRates: [] }, 'Without the tour');
    expect((await setSale(admin, w.pkg.id, 'open')).status).toBe(200);
    expect((await admin.post('/admin/pricing/quotes', quoteBody(w))).body.totalMinor).toBe('132500');
  });

  it('remove_optional_extra_on_sale: an optional extra goes while on sale, and the package stays open', async () => {
    const w = await pricedWorld(admin);
    expect((await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/extras/${w.extraId}`)).status).toBe(200);
    await must(setSale(admin, w.pkg.id, 'closed'), 'close');
    expect((await setSale(admin, w.pkg.id, 'open')).status).toBe(200);
  });

  it('open_gate_checks_scheduled_versions: a scheduled version that no longer prices what the package offers blocks reopening', async () => {
    const w = await pricedWorld(admin);
    // scheduled with free extra nights, complete while the package offers none
    const s = await schedule(w, { ...w.rates, roomRates: w.rates.roomRates.map((r) => ({ ...r, extraNightPerPersonMinor: '0' })) }, inHours(2));
    expect(s.res.status).toBe(200);
    await must(setSale(admin, w.pkg.id, 'closed'), 'close');
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    await must(admin.patch(`/admin/catalogue/packages/${w.pkg.id}`, { maxExtraNightsAfter: 2, version: pkg.version }), 'offer extra nights');
    expect((await setSale(admin, w.pkg.id, 'open')).body.code).toBe('price_version_incomplete');
    expect((await withdraw(s.id)).status).toBe(200);
    expect((await setSale(admin, w.pkg.id, 'open')).status).toBe(200);
  });

  it('migration_backfills_priced_terms and priced_terms_backfill_package_without_extras: the backfill of 0010, run again and rolled back', async () => {
    const withExtras = await pricedWorld(admin, { open: false });
    const bare = await buildWorld(admin, { priced: false });
    const pkg = (await admin.get(`/admin/catalogue/packages/${bare.pkg.id}`)).body;
    await must(admin.delete(`/admin/catalogue/packages/${bare.pkg.id}/extras/${pkg.extras[0].id}`), 'remove the only extra');
    const ids = { roomId: pkg.hotels[0].rooms[0].id, extraId: pkg.extras[0].id, distanceId: bare.distanceId };
    const bareVersion = await publishWith(admin, bare.pkg.id, { ...cardFor(ids), participationRates: [], extraRates: [] });
    expect((await row(bareVersion)).pricedTerms).toEqual([]);
    const migration = readFileSync(join(process.cwd(), 'prisma/migrations/0010_pricing_rules_promos/migration.sql'), 'utf8');
    const backfill = /ALTER TABLE "price_versions" DISABLE TRIGGER[\s\S]*?ENABLE TRIGGER "price_versions_guard";/.exec(migration)![0];
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      // the backfill exactly as the migration runs it, on versions whose terms are made stale first; the withdrawal
      // check, created after the backfill in 0010, is off here as it did not exist then
      await owner.query(`ALTER TABLE "price_versions" DISABLE TRIGGER "price_versions_withdrawn"`);
      await owner.query(backfill.replace(/UPDATE "price_versions" v SET[\s\S]*?WHERE v."status" = 'published';/, `UPDATE price_versions SET "pricedTerms" = '[{"stale": true}]' WHERE id IN ('${bareVersion}', '${withExtras.versionId}');`));
      await owner.query(backfill);
      await owner.query(`ALTER TABLE "price_versions" ENABLE TRIGGER "price_versions_withdrawn"`);
      const { rows } = await owner.query(`SELECT id, "pricedTerms" FROM price_versions WHERE id IN ($1, $2)`, [bareVersion, withExtras.versionId]);
      const byId = Object.fromEntries(rows.map((r: { id: string; pricedTerms: unknown }) => [r.id, r.pricedTerms]));
      expect(byId[bareVersion]).toEqual([]);
      expect(byId[withExtras.versionId]).toEqual([{ extraId: withExtras.extraId, pricingUnit: 'per_person', mandatory: false, availableTo: null }]);
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }
  });
});
