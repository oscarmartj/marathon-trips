// public_quote_rate_limited_per_ip (M13): its own app, so the limiter starts empty.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PUBLIC_QUOTES_PER_MINUTE } from '../../../src/modules/pricing/quote-rate-limit.guard';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

describe('public_quote_rate_limited_per_ip', () => {
  it(`allows ${PUBLIC_QUOTES_PER_MINUTE} quotes a minute from one address, then answers 429 with Retry-After`, async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_QUOTES_PER_MINUTE; i++) statuses.push((await t.http().post('/pricing/quotes').set(STATE_HEADERS).send({})).status);
    expect(new Set(statuses)).toEqual(new Set([422]));
    const over = await t.http().post('/pricing/quotes').set(STATE_HEADERS).send({});
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('60');
  });
});
