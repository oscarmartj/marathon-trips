import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConsumerRegistry } from '../../src/platform/events/consumers';
import { moduleFlagKey } from '../../src/platform/flags/flags.service';
import { Platform, cleanEvents, makePlatform, newId } from '../support/platform';

let p: Platform;
beforeAll(async () => {
  p = await makePlatform();
});
afterAll(async () => p.close());
afterEach(async () => {
  await cleanEvents(p);
  await p.prisma.featureFlag.deleteMany({ where: { key: { startsWith: 'module.testmod' } } });
  // each test registers its own consumers on a fresh registry
  (p.registry as unknown as { consumers: Map<string, unknown> }).consumers.clear();
});

const publish = async (type = 'testing.happened', extra: Partial<{ occurredAt: Date }> = {}) => {
  const aggregateId = newId();
  const id = await p.prisma.$transaction(async (tx) => {
    const eventId = await p.outbox.publish(tx, { type, aggregateType: 'Thing', aggregateId, actorType: 'system', payload: { thingId: aggregateId } });
    if (extra.occurredAt) await tx.outboxEvent.update({ where: { id: eventId }, data: { occurredAt: extra.occurredAt } });
    return eventId;
  });
  return { id, aggregateId };
};
const deliveryFor = (eventId: string, consumer: string) => p.prisma.eventDelivery.findUniqueOrThrow({ where: { eventId_consumer: { eventId, consumer } } });

describe('outbox (plan 4.5)', () => {
  it('rolled_back_transaction_publishes_no_event', async () => {
    const aggregateId = newId();
    await expect(
      p.prisma.$transaction(async (tx) => {
        await p.outbox.publish(tx, { type: 'testing.happened', aggregateType: 'Thing', aggregateId, actorType: 'system' });
        throw new Error('business rule failed after publishing');
      }),
    ).rejects.toThrow();
    expect(await p.prisma.outboxEvent.count({ where: { aggregateId } })).toBe(0);
  });

  it('rejects personal data, amounts and bad type names in the payload', async () => {
    await p.prisma.$transaction(async (tx) => {
      const bad = (payload: Record<string, unknown>) => p.outbox.publish(tx, { type: 'testing.happened', aggregateType: 'Thing', aggregateId: newId(), actorType: 'system', payload });
      await expect(bad({ email: 'a@b.c' })).rejects.toMatchObject({ code: 'payload_not_identifiers_only' });
      await expect(bad({ nested: { totalMinor: 5 } })).rejects.toMatchObject({ code: 'payload_not_identifiers_only' });
      await expect(p.outbox.publish(tx, { type: 'Bad Type', aggregateType: 'T', aggregateId: newId(), actorType: 'system' })).rejects.toMatchObject({ code: 'event_bad_type' });
    });
  });

  it('dispatches once per consumer, with one pg-boss job per delivery', async () => {
    p.registry.register({ name: 'test-a', module: 'platform', events: ['testing.*'], whenDisabled: 'skip', handle: async () => undefined });
    p.registry.register({ name: 'test-b', module: 'platform', events: ['testing.happened'], whenDisabled: 'skip', handle: async () => undefined });
    p.registry.register({ name: 'test-other', module: 'platform', events: ['testing.other'], whenDisabled: 'skip', handle: async () => undefined });
    const { id } = await publish();
    expect(await p.events.dispatchPending()).toBeGreaterThanOrEqual(1);
    expect((await p.prisma.eventDelivery.findMany({ where: { eventId: id } })).map((d) => d.consumer).sort()).toEqual(['test-a', 'test-b']);
    expect((await p.prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).dispatchedAt).not.toBeNull();
    const jobs = await p.prisma.$queryRawUnsafe<Array<{ singleton_key: string }>>(`SELECT singleton_key FROM pgboss.job WHERE name = 'events.deliver' AND singleton_key LIKE $1`, `test-%:${id}`);
    expect(jobs.map((j) => j.singleton_key).sort()).toEqual([`test-a:${id}`, `test-b:${id}`]);
    expect(await p.events.dispatchPending()).toBe(0); // already dispatched: nothing happens twice
  });

  it('two dispatchers running together create each delivery once (SKIP LOCKED)', async () => {
    p.registry.register({ name: 'test-a', module: 'platform', events: ['testing.*'], whenDisabled: 'skip', handle: async () => undefined });
    const ids = await Promise.all([publish(), publish(), publish(), publish()]);
    await Promise.all([p.events.dispatchPending(), p.events.dispatchPending(), p.events.dispatchPending()]);
    for (const { id } of ids) expect(await p.prisma.eventDelivery.count({ where: { eventId: id } })).toBe(1);
  });
});

describe('consumers', () => {
  it('double_delivery_processed_once', async () => {
    let calls = 0;
    p.registry.register({ name: 'test-once', module: 'platform', events: ['testing.happened'], whenDisabled: 'skip', handle: async () => void (calls += 1) });
    const { id } = await publish();
    await p.events.dispatchPending();
    const d = await deliveryFor(id, 'test-once');
    const outcomes = await Promise.all([p.events.processDelivery(d.id), p.events.processDelivery(d.id)]);
    expect(await p.events.processDelivery(d.id)).toBe('noop');
    expect(calls).toBe(1);
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(1);
    expect((await deliveryFor(id, 'test-once')).status).toBe('done');
  });

  it('the handler runs in the delivery transaction: its writes roll back when it fails', async () => {
    const key = `test-handler-${newId()}`;
    p.registry.register({
      name: 'test-tx', module: 'platform', events: ['testing.happened'], whenDisabled: 'skip', maxAttempts: 2,
      handle: async (_e, { tx }) => {
        await tx.setting.create({ data: { key, value: {} } });
        throw new Error('boom');
      },
    });
    const { id } = await publish();
    await p.events.dispatchPending();
    const d = await deliveryFor(id, 'test-tx');
    await expect(p.events.processDelivery(d.id)).rejects.toThrow();
    expect(await p.prisma.setting.count({ where: { key } })).toBe(0);
    expect((await deliveryFor(id, 'test-tx')).attempts).toBe(1);
  });

  it('skip with the flag off marks skipped; the handler does not run', async () => {
    let calls = 0;
    p.registry.register({ name: 'test-skip', module: 'testmod', events: ['testing.happened'], whenDisabled: 'skip', handle: async () => void (calls += 1) });
    const { id } = await publish();
    await p.events.dispatchPending();
    const d = await deliveryFor(id, 'test-skip');
    expect(await p.events.processDelivery(d.id)).toBe('skipped');
    expect(calls).toBe(0);
    expect((await deliveryFor(id, 'test-skip')).status).toBe('skipped');
  });

  it('hold leaves the delivery pending and processes it once the module is on', async () => {
    let calls = 0;
    p.registry.register({ name: 'test-hold', module: 'testmod', events: ['testing.happened'], whenDisabled: 'hold', handle: async () => void (calls += 1) });
    const { id } = await publish();
    await p.events.dispatchPending();
    const d = await deliveryFor(id, 'test-hold');
    expect(await p.events.processDelivery(d.id)).toBe('held');
    expect((await deliveryFor(id, 'test-hold')).status).toBe('pending');
    expect(await p.events.releaseHeld('testmod')).toBe(0); // module still off
    await p.flags.ensure(moduleFlagKey('testmod'), true);
    expect(await p.events.releaseHeld('testmod')).toBeGreaterThanOrEqual(1);
    expect(await p.events.processDelivery(d.id)).toBe('done');
    expect(calls).toBe(1);
  });

  it('stale_notify_event_skipped_after_reenable', async () => {
    let calls = 0;
    p.registry.register({ name: 'test-notify', module: 'testmod', events: ['testing.happened'], whenDisabled: 'hold', notifyOnly: true, handle: async () => void (calls += 1) });
    const { id } = await publish();
    await p.events.dispatchPending();
    const d = await deliveryFor(id, 'test-notify');
    expect(await p.events.processDelivery(d.id)).toBe('held');
    await p.flags.ensure(moduleFlagKey('testmod'), true);
    const threeDaysLater = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    expect(await p.events.processDelivery(d.id, threeDaysLater)).toBe('skipped'); // older than the 48 h default
    expect(calls).toBe(0);
  });

  it('a state-changing consumer has no maxEventAge: an old held event still runs after re-enable', async () => {
    let calls = 0;
    p.registry.register({ name: 'test-state', module: 'testmod', events: ['testing.happened'], whenDisabled: 'hold', handle: async () => void (calls += 1) });
    const { id } = await publish();
    await p.events.dispatchPending();
    const d = await deliveryFor(id, 'test-state');
    await p.flags.ensure(moduleFlagKey('testmod'), true);
    expect(await p.events.processDelivery(d.id, new Date(Date.now() + 30 * 24 * 3600 * 1000))).toBe('done');
    expect(calls).toBe(1);
  });

  it('marks a delivery failed after its attempts, with a safe error, and retryFailed puts it back', async () => {
    p.registry.register({ name: 'test-fail', module: 'platform', events: ['testing.happened'], whenDisabled: 'skip', maxAttempts: 2, handle: async () => { throw new Error('customer jane@example.com broke it'); } });
    const { id } = await publish();
    await p.events.dispatchPending();
    const d = await deliveryFor(id, 'test-fail');
    await expect(p.events.processDelivery(d.id)).rejects.toThrow();
    expect(await p.events.processDelivery(d.id)).toBe('failed');
    const failed = await deliveryFor(id, 'test-fail');
    expect(failed).toMatchObject({ status: 'failed', attempts: 2 });
    expect(failed.lastError).toBe('unexpected_error: An unexpected error occurred');
    expect(JSON.stringify(failed)).not.toContain('jane');
    await p.events.retryFailed(d.id);
    expect(await deliveryFor(id, 'test-fail')).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
  });

  it('unique_violation_error_does_not_store_value', async () => {
    const secret = `value-that-must-not-be-stored-${newId()}`;
    await p.flags.ensure(secret, false);
    p.registry.register({
      name: 'test-unique', module: 'platform', events: ['testing.happened'], whenDisabled: 'skip', maxAttempts: 1,
      handle: async (_e, { tx }) => void (await tx.featureFlag.create({ data: { key: secret } })),
    });
    const { id } = await publish();
    await p.events.dispatchPending();
    const d = await deliveryFor(id, 'test-unique');
    expect(await p.events.processDelivery(d.id)).toBe('failed');
    const row = await deliveryFor(id, 'test-unique');
    expect(row.lastError).toBe('prisma_P2002: A unique constraint was violated');
    expect(JSON.stringify(row)).not.toContain(secret);
    await p.prisma.featureFlag.deleteMany({ where: { key: secret } });
  });

  it('registration rules: payments, bookings and changes events must hold; maxEventAge only for notice-only consumers', () => {
    const r = new ConsumerRegistry();
    const base = { module: 'crm', whenDisabled: 'skip' as const, handle: async () => undefined };
    for (const events of [['payments.captured'], ['bookings.*'], ['changes.requested'], ['*']]) {
      expect(() => r.register({ ...base, name: `t-${events[0]}`, events })).toThrow(/whenDisabled must be hold/);
    }
    expect(() => r.register({ ...base, name: 'ok-skip', events: ['crm.quote_sent'] })).not.toThrow();
    expect(() => r.register({ ...base, name: 'ok-hold', whenDisabled: 'hold', events: ['bookings.*'] })).not.toThrow();
    expect(() => r.register({ ...base, name: 'age', whenDisabled: 'hold', events: ['bookings.*'], maxEventAgeMs: 1000 })).toThrow(/cannot declare maxEventAgeMs/);
    expect(() => r.register({ ...base, name: 'age2', whenDisabled: 'hold', notifyOnly: true, maxEventAgeMs: 1000, events: ['bookings.*'] })).not.toThrow();
    expect(() => r.register({ ...base, name: 'ok-hold', events: ['x.y'] })).toThrow(/already registered/);
    expect(() => r.register({ ...base, name: 'bad', events: ['Not A Pattern'] })).toThrow(/bad event pattern/);
    expect(r.forEvent('bookings.approved').map((c) => c.name).sort()).toEqual(['age2', 'ok-hold']);
  });
});

describe('retention', () => {
  it('purges finished deliveries and events older than 90 days, never pending ones', async () => {
    p.registry.register({ name: 'test-purge', module: 'platform', events: ['testing.happened'], whenDisabled: 'skip', handle: async () => undefined });
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    const finished = await publish('testing.happened', { occurredAt: old });
    const pending = await publish('testing.happened', { occurredAt: old });
    await p.events.dispatchPending();
    await p.events.processDelivery((await deliveryFor(finished.id, 'test-purge')).id);
    const result = await p.events.purge();
    expect(result.deliveries).toBeGreaterThanOrEqual(1);
    expect(await p.prisma.outboxEvent.count({ where: { id: finished.id } })).toBe(0);
    expect(await p.prisma.outboxEvent.count({ where: { id: pending.id } })).toBe(1);
  });
});
