// Redeeming and releasing promo codes with real concurrent transactions (plan docs/plans/2.2-pricing-rules-promo-codes.md,
// sections 8 and 15, points 2, 3 and 9). Task 2.4 calls these services inside its request transaction.
// Since 2.4 a redemption points at a real booking of its customer (foreign keys): each redemption gets one from
// makeBookingFor, created before the concurrent part starts. The assertions are the ones of 2.2, unchanged.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../src/generated/prisma/client';
import { PromoRedemptionService, QuoteService, REDEEM_TX_OPTIONS, publicRedemptionError } from '../../../src/modules/pricing';
import { REDEMPTION_FAILURE_CODES } from '../../../src/modules/pricing/promo-redemption.service';
import { runTransaction } from '../../../src/platform/database/transaction';
import { ApiError } from '../../../src/platform/http/api-error';
import { TestApp, makeApp } from '../../support/auth';
import { Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { createCode, freshCode, promoBody } from '../../support/adjustments';
import { makeBookingFor, makeCustomer } from '../../support/bookings';
import { pricedWorld, quoteBody } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
let w: PricedWorld;
let svc: PromoRedemptionService;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t);
  w = await pricedWorld(admin);
  svc = t.app.get(PromoRedemptionService);
});
afterAll(async () => {
  await closeCatalogue(t);
});

const RC = Prisma.TransactionIsolationLevel.ReadCommitted;
const RR = Prisma.TransactionIsolationLevel.RepeatableRead;
const uuid = () => crypto.randomUUID();
type Who = { customerId: string; bookingId: string };
/** A booking (and its customer, unless given) for a redemption to point at. */
const who = (customerId?: string): Promise<Who> => makeBookingFor(t, w, customerId);
const whos = (n: number, customerId?: string): Promise<Who[]> => Promise.all(Array.from({ length: n }, () => who(customerId)));
const code = (over: Record<string, unknown> = {}) => createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, ...over });
const counted = async (id: string) => (await t.prisma.promoCode.findUniqueOrThrow({ where: { id } })).redeemedCount;
const active = (promoCodeId: string) => t.prisma.promoRedemption.count({ where: { promoCodeId, releasedAt: null } });

/** One redemption in its own transaction, as 2.4's request will run it. */
const redeem = (c: { id: string; version: number }, x: Who, opts: { isolationLevel?: Prisma.TransactionIsolationLevel; maxAttempts?: number } = {}) =>
  runTransaction(t.prisma, (tx) => svc.redeemIn(tx, { promoCodeId: c.id, promoCodeVersion: c.version, bookingId: x.bookingId, customerId: x.customerId, now: new Date() }), {
    isolationLevel: opts.isolationLevel ?? REDEEM_TX_OPTIONS.isolationLevel, maxAttempts: opts.maxAttempts, maxWait: 20_000, timeout: 20_000,
  });

/** Every loser is a 409 with a redemption code: never a 500, never a raw 40001. */
function losersAre409(results: PromiseSettledResult<unknown>[]): string[] {
  const codes: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') continue;
    expect(r.reason, String(r.reason)).toBeInstanceOf(ApiError);
    expect((r.reason as ApiError).status).toBe(409);
    expect(REDEMPTION_FAILURE_CODES.has((r.reason as ApiError).code), (r.reason as ApiError).code).toBe(true);
    codes.push((r.reason as ApiError).code);
  }
  return codes;
}

describe('limits under concurrency', () => {
  it.each<[string, Prisma.TransactionIsolationLevel, number, number]>([
    ['READ COMMITTED, 1 per customer', RC, 1, 3],
    ['READ COMMITTED, 2 per customer', RC, 2, 3],
    ['REPEATABLE READ, 1 per customer', RR, 1, 10],
    ['REPEATABLE READ, 2 per customer', RR, 2, 10],
  ])('max_per_customer_concurrent_redemptions: %s — 8 at once, exactly the maximum win', async (_n, isolationLevel, max, maxAttempts) => {
    const c = await code({ maxPerCustomer: max });
    const mine = await whos(8, await makeCustomer(t));
    const results = await Promise.allSettled(mine.map((x) => redeem(c, x, { isolationLevel, maxAttempts })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(max);
    const codes = losersAre409(results);
    expect(codes.every((x) => x === 'promo_code_customer_limit' || x === 'busy_try_again')).toBe(true);
    expect([await counted(c.id), await active(c.id)]).toEqual([max, max]);
  });

  it.each<[string, Prisma.TransactionIsolationLevel, number]>([
    ['READ COMMITTED', RC, 3],
    ['REPEATABLE READ', RR, 10],
  ])('max_redemptions_concurrent: %s — 3 of 8 customers win', async (_n, isolationLevel, maxAttempts) => {
    const c = await code({ maxRedemptions: 3 });
    const results = await Promise.allSettled((await whos(8)).map((x) => redeem(c, x, { isolationLevel, maxAttempts })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(losersAre409(results).every((x) => x === 'promo_code_unavailable' || x === 'busy_try_again')).toBe(true);
    expect([await counted(c.id), await active(c.id)]).toEqual([3, 3]);
  });

  it.each<[string, Prisma.TransactionIsolationLevel, number]>([
    ['READ COMMITTED with the default attempts', RC, 3],
    ['REPEATABLE READ with enough attempts', RR, 10],
  ])('redeem_contention_with_capacity_all_succeed: %s — 8 at once, room for 8', async (_n, isolationLevel, maxAttempts) => {
    const c = await code({ maxRedemptions: 8 });
    const results = await Promise.allSettled((await whos(8)).map((x) => redeem(c, x, { isolationLevel, maxAttempts })));
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await counted(c.id)).toBe(8);
  });

  it('REPEATABLE READ with too few attempts: the losers get 409 busy_try_again, never a 500 or 40001', async () => {
    const c = await code();
    const results = await Promise.allSettled((await whos(8)).map((x) => redeem(c, x, { isolationLevel: RR, maxAttempts: 1 })));
    const codes = losersAre409(results);
    expect(codes.every((x) => x === 'busy_try_again')).toBe(true);
    expect(await counted(c.id)).toBe(results.filter((r) => r.status === 'fulfilled').length);
  });

  it('promo_max_below_redeemed_concurrent_is_409: lowering the limit while codes are redeemed is 200 or 409, never 500', async () => {
    const c = await code({ maxRedemptions: 5 });
    const patch = () => admin.patch(`/admin/pricing/promo-codes/${c.id}`, { ...promoBody('X'), code: undefined, scopeType: undefined, maxRedemptions: 2, version: c.version });
    const four = await whos(4);
    const [patched, ...redeemed] = await Promise.allSettled([patch(), ...four.map((x) => redeem(c, x))]);
    expect(patched.status).toBe('fulfilled');
    const res = (patched as PromiseFulfilledResult<Awaited<ReturnType<typeof patch>>>).value;
    expect([200, 409]).toContain(res.status);
    if (res.status === 409) expect(['max_below_redeemed', 'version_conflict']).toContain(res.body.code);
    losersAre409(redeemed);
    const row = await t.prisma.promoCode.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.redeemedCount).toBeLessThanOrEqual(row.maxRedemptions!);
    expect(row.redeemedCount).toBe(await active(c.id));
  });
});

describe('one booking, one code', () => {
  it('redeem_idempotent_same_booking: the same request twice counts once', async () => {
    const c = await code();
    const x = await who();
    const first = await redeem(c, x);
    const again = await redeem(c, x);
    expect([first.created, again.created, again.redemptionId]).toEqual([true, false, first.redemptionId]);
    expect(await counted(c.id)).toBe(1);
  });

  it('one_active_redemption_per_booking: a second code on the same booking is refused until the first is released', async () => {
    const [a, b] = [await code(), await code()];
    const x = await who();
    const { bookingId } = x;
    await redeem(a, x);
    await expect(redeem(b, x)).rejects.toMatchObject({ status: 409, code: 'booking_has_promo_code' });
    expect(await counted(b.id)).toBe(0);
    expect(await runTransaction(t.prisma, (tx) => svc.releaseIn(tx, { promoCodeId: a.id, bookingId, now: new Date() }))).toBe(true);
    await redeem(b, x);
    expect([await counted(a.id), await counted(b.id)]).toEqual([0, 1]);
  });

  it('release_once_concurrent: two releases at once give back one redemption', async () => {
    const c = await code();
    const x = await who();
    const { bookingId } = x;
    await redeem(c, x);
    const releases = await Promise.all([1, 2].map(() => runTransaction(t.prisma, (tx) => svc.releaseIn(tx, { promoCodeId: c.id, bookingId, now: new Date() }), REDEEM_TX_OPTIONS)));
    expect(releases.sort()).toEqual([false, true]);
    expect([await counted(c.id), await active(c.id)]).toEqual([0, 0]);
    // a released redemption is not redeemed again for the same booking
    await expect(redeem(c, { customerId: await makeCustomer(t), bookingId })).rejects.toMatchObject({ status: 409, code: 'promo_code_unavailable' });
  });

  it('released_redemption_frees_customer_quota and the global count', async () => {
    const c = await code({ maxPerCustomer: 1, maxRedemptions: 2 });
    const customer = await makeCustomer(t);
    const first = await who(customer);
    await redeem(c, first);
    await expect(redeem(c, await who(customer))).rejects.toMatchObject({ code: 'promo_code_customer_limit' });
    await redeem(c, await who());
    await expect(redeem(c, await who())).rejects.toMatchObject({ code: 'promo_code_unavailable' });
    await runTransaction(t.prisma, (tx) => svc.releaseIn(tx, { promoCodeId: c.id, bookingId: first.bookingId, now: new Date() }));
    await redeem(c, await who(customer));
    expect([await counted(c.id), await active(c.id)]).toEqual([2, 2]);
  });

  it('redeem_rejects_unusable_code: disabled, expired or archived; a release still works after archiving', async () => {
    const disabled = await code({ enabled: false });
    await expect(redeem(disabled, await who())).rejects.toMatchObject({ code: 'promo_code_unavailable' });
    const expired = await code({ validFrom: new Date(Date.now() - 7_200_000).toISOString(), validTo: new Date(Date.now() - 3_600_000).toISOString() });
    await expect(redeem(expired, await who())).rejects.toMatchObject({ code: 'promo_code_unavailable' });
    const c = await code();
    const x = await who();
    const { bookingId } = x;
    await redeem(c, x);
    const archived = (await admin.post(`/admin/pricing/promo-codes/${c.id}/archive`, { version: c.version })).body;
    await expect(redeem({ id: c.id, version: archived.version }, await who())).rejects.toMatchObject({ code: 'promo_code_unavailable' });
    expect(await runTransaction(t.prisma, (tx) => svc.releaseIn(tx, { promoCodeId: c.id, bookingId, now: new Date() }))).toBe(true);
    expect(await counted(c.id)).toBe(0);
  });
});

describe('the code the quote saw', () => {
  it('redeem_rejects_code_changed_since_quote; priceWithPromoRef gives the ref only when the code applied', async () => {
    const c = await code();
    const quotes = t.app.get(QuoteService);
    const req = { ...quoteBody(w, { promoCode: c.code }), extraNightsBefore: 0, extraNightsAfter: 0, extras: [] };
    const quoted = await t.prisma.$transaction((tx) => quotes.priceWithPromoRef(tx, req as never, { audience: 'public', now: new Date() }));
    expect([quoted.breakdown.promo.status, quoted.promoRef]).toEqual(['applied', { id: c.id, version: c.version }]);
    const none = await t.prisma.$transaction((tx) => quotes.priceWithPromoRef(tx, { ...req, promoCode: freshCode() } as never, { audience: 'public', now: new Date() }));
    expect(none.promoRef).toBeNull();
    // the code changes between the quote and the redemption: 409, nothing counted
    await admin.patch(`/admin/pricing/promo-codes/${c.id}`, { ...promoBody('X'), code: undefined, scopeType: undefined, valueBps: 2000, version: c.version });
    await expect(redeem({ id: quoted.promoRef!.id, version: quoted.promoRef!.version }, await who())).rejects.toMatchObject({ status: 409, code: 'promo_code_changed' });
    expect(await counted(c.id)).toBe(0);
  });

  it('public_redemption_error_is_single: every redemption failure reads the same to the public', () => {
    const answers = [...REDEMPTION_FAILURE_CODES].map((code) => publicRedemptionError(new ApiError(409, code, 'x')) as ApiError);
    for (const a of answers) expect([a.status, a.code, a.message]).toEqual([409, 'promo_code_unavailable', 'That code can no longer be used. Remove it to continue.']);
    const other = new ApiError(422, 'occupancy_out_of_range', 'x');
    expect(publicRedemptionError(other)).toBe(other);
  });
});

describe('redemption_rows_immutable: what the database guarantees', () => {
  it('only the release changes, once; never a delete or a truncate; active mirrors the booking', async () => {
    const c = await code();
    const { redemptionId } = await redeem(c, await who());
    const sql = (q: string, ...p: unknown[]) => t.prisma.$executeRawUnsafe(q, ...p);
    await expect(sql(`UPDATE promo_redemptions SET "customerId" = $2::uuid WHERE id = $1::uuid`, redemptionId, uuid())).rejects.toThrow(/only released, once/);
    await expect(sql(`UPDATE promo_redemptions SET "releasedAt" = now() WHERE id = $1::uuid`, redemptionId)).rejects.toThrow(/only released, once/);
    await expect(sql(`DELETE FROM promo_redemptions WHERE id = $1::uuid`, redemptionId)).rejects.toThrow(/never deleted/);
    await expect(sql(`TRUNCATE promo_redemptions`)).rejects.toThrow(/append-only|permission denied|must be owner/);
    await expect(sql(`INSERT INTO promo_redemptions (id, "promoCodeId", "bookingId", "customerId", "activeBookingId", "redeemedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid, now())`, uuid(), c.id, uuid(), uuid())).rejects.toThrow(/promo_redemptions_active_check/);
    await sql(`UPDATE promo_redemptions SET "releasedAt" = now(), "activeBookingId" = NULL WHERE id = $1::uuid`, redemptionId);
    await expect(sql(`UPDATE promo_redemptions SET "releasedAt" = now() + interval '1 day' WHERE id = $1::uuid`, redemptionId)).rejects.toThrow(/only released, once/);
  });
});
