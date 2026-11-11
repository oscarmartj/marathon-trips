import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyService, IdempotencyRequest } from '../../src/platform/idempotency/idempotency.service';
import { PrismaService } from '../../src/platform/database/prisma.service';
import { testConfig, newId } from '../support/platform';

let prisma: PrismaService;
let svc: IdempotencyService;
beforeAll(() => {
  prisma = new PrismaService(testConfig());
  svc = new IdempotencyService(prisma);
});
afterAll(async () => prisma.$disconnect());
afterEach(async () => {
  await prisma.idempotencyRecord.deleteMany({ where: { actorId: { startsWith: 'test-' } } });
});

const req = (over: Partial<IdempotencyRequest> = {}): IdempotencyRequest => ({
  actorType: 'customer', actorId: `test-${newId()}`, route: 'POST /things', key: 'key-1', body: { a: 1, b: [1, 2] }, ...over,
});

describe('idempotency (plan 4.1)', () => {
  it('runs the handler once and repeats the stored status and resource', async () => {
    const r = req();
    const resourceId = newId();
    let calls = 0;
    const handler = async () => { calls += 1; return { status: 201, resourceType: 'Thing', resourceId }; };
    const first = await svc.run(r, handler);
    const second = await svc.run({ ...r, body: { b: [1, 2], a: 1 } }, handler); // same body, other key order
    expect(calls).toBe(1);
    expect(first).toEqual({ replayed: false, result: { status: 201, resourceType: 'Thing', resourceId } });
    expect(second).toEqual({ replayed: true, result: { status: 201, resourceType: 'Thing', resourceId } });
  });

  it('stores no response body: the table has no column for one, and only a hash of the request', async () => {
    const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'idempotency_records'`;
    const names = cols.map((c) => c.column_name);
    expect(names.filter((n) => /body|response(?!Status)|payload|json/i.test(n))).toEqual([]);
    const r = req({ body: { marker: 'plain-text-marker-9' } });
    await svc.run(r, async () => ({ status: 200 }));
    const row = await prisma.idempotencyRecord.findFirstOrThrow({ where: { actorId: r.actorId } });
    expect(JSON.stringify(row)).not.toContain('plain-text-marker-9');
  });

  it('the same key with a different body is 422', async () => {
    const r = req();
    await svc.run(r, async () => ({ status: 200 }));
    await expect(svc.run({ ...r, body: { a: 2 } }, async () => ({ status: 200 }))).rejects.toMatchObject({ status: 422 });
  });

  it('the same key from another actor or route is a different request', async () => {
    const r = req();
    let calls = 0;
    const h = async () => { calls += 1; return { status: 200 }; };
    await svc.run(r, h);
    await svc.run({ ...r, actorId: `test-${newId()}` }, h);
    await svc.run({ ...r, route: 'POST /other' }, h);
    expect(calls).toBe(3);
  });

  it('a request still in progress is 409; after the lock lapses it can be taken over', async () => {
    const r = req();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = svc.run(r, async () => { await gate; return { status: 200 }; });
    await new Promise((res) => setTimeout(res, 50));
    await expect(svc.run(r, async () => ({ status: 200 }))).rejects.toMatchObject({ status: 409 });
    release();
    await slow;
    // simulate a crashed first caller: in progress with an expired lock
    const r2 = req();
    await prisma.idempotencyRecord.create({
      data: { scope: IdempotencyService.scope(r2), actorType: r2.actorType, actorId: r2.actorId, key: r2.key, requestHash: (await hashOf(r2)), lockedUntil: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 3600_000) },
    });
    const out = await svc.run(r2, async () => ({ status: 200 }));
    expect(out.replayed).toBe(false);
  });

  it('a failing handler removes the record so the retry runs', async () => {
    const r = req();
    await expect(svc.run(r, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let calls = 0;
    await svc.run(r, async () => { calls += 1; return { status: 200 }; });
    expect(calls).toBe(1);
  });

  it('records expire after 24 hours: a later request with the same key runs again', async () => {
    const r = req();
    let calls = 0;
    const h = async () => { calls += 1; return { status: 200 }; };
    const t0 = new Date();
    await svc.run(r, h, t0);
    await svc.run(r, h, new Date(t0.getTime() + 23 * 3600_000));
    expect(calls).toBe(1);
    await svc.run(r, h, new Date(t0.getTime() + 25 * 3600_000));
    expect(calls).toBe(2);
  });

  it('refuses a request with no actor or no key (a public route without a token has no idempotency)', async () => {
    await expect(svc.run(req({ actorId: '' }), async () => ({ status: 200 }))).rejects.toMatchObject({ code: 'idempotency_requires_actor_and_key' });
    await expect(svc.run(req({ key: '' }), async () => ({ status: 200 }))).rejects.toMatchObject({ code: 'idempotency_requires_actor_and_key' });
  });
});

import { canonicalJson, sha256Hex } from '../../src/platform/crypto/hmac';
const hashOf = async (r: IdempotencyRequest) => sha256Hex(canonicalJson(r.body ?? null));
