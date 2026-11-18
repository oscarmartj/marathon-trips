import type { Express, Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientIpWatch, isPrivateAddress, PROXIED_HEADER } from '../../src/platform/http/client-ip-watch';
import { SystemMonitorService } from '../../src/platform/monitor/system-monitor.service';
import { TestApp, makeApp } from '../support/auth';
import { testConfig } from '../support/platform';

// Task 8.5 (S-04): the client address behind Caddy → web → API, with the production settings of deploy/: Caddy sets
// X-Forwarded-For to the address it sees, the web app forwards the last entry (WEB_TRUSTED_PROXY_HOPS=1), and the API
// trusts private hops (TRUST_PROXY=uniquelocal). The test reads req.ip from the real Express app the API configures.
let t: TestApp;
let express: Express;
beforeAll(async () => {
  t = await makeApp({ TRUST_PROXY: 'uniquelocal' });
  express = t.app.getHttpAdapter().getInstance() as Express;
});
afterAll(async () => t.close());

/** req.ip of a request that reaches the API from `peer` (the web container) with this X-Forwarded-For. */
function ipFor(peer: string, xff?: string): string | undefined {
  const req = Object.create(express.request) as Request & { app: Express };
  const socket = { remoteAddress: peer, encrypted: false };
  Object.assign(req, { app: express, headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket, connection: socket });
  return req.ip;
}

describe('client address behind the proxies (S-04)', () => {
  const web = '172.18.0.3';

  it('the browser address Caddy saw reaches the API', () => {
    expect(ipFor(web, '203.0.113.7')).toBe('203.0.113.7');
    expect(ipFor(web, '2001:db8::7')).toBe('2001:db8::7');
  });

  it('without the web app in front (no X-Forwarded-For) the address is the web container: private', () => {
    expect(isPrivateAddress(ipFor(web))).toBe(true);
  });

  it('a request from a public peer cannot choose its address with X-Forwarded-For', () => {
    expect(ipFor('198.51.100.9', '203.0.113.7')).toBe('198.51.100.9');
  });

  it("Docker's userland proxy: Caddy sees the network gateway as every client, the API gets a private address, and the watch notices", () => {
    // What happens with IPv6 clients (or userland-proxy) on Docker: the address Caddy sees is the bridge gateway.
    const collapsed = ipFor(web, '172.18.0.1');
    expect(collapsed).toBe('172.18.0.1');
    expect(isPrivateAddress(collapsed)).toBe(true);
  });

  it.each([
    ['10.1.2.3', true], ['172.31.255.1', true], ['192.168.1.1', true], ['127.0.0.1', true], ['::1', true], ['fd00::1', true], ['fe80::1', true],
    ['::ffff:172.18.0.1', true], ['::ffff:203.0.113.7', false], ['203.0.113.7', false], ['2001:db8::1', false], ['172.32.0.1', false], [undefined, true],
  ] as const)('isPrivateAddress(%s) is %s', (ip, expected) => expect(isPrivateAddress(ip)).toBe(expected));
});

describe('system monitor reports lost client addresses in production (S-04)', () => {
  it('counts proxied requests only, and only production turns a private address into "attention"', async () => {
    clientIpWatch.reset();
    const now = new Date();
    clientIpWatch.record(false, '172.18.0.3', false, now); // the web app's own server-side call: not counted
    clientIpWatch.record(true, '203.0.113.7', false, now);
    expect(clientIpWatch.privateAddress).toBe(0);
    clientIpWatch.record(true, '172.18.0.1', false, now);
    expect([clientIpWatch.proxied, clientIpWatch.privateAddress]).toEqual([2, 1]);

    const monitor = t.app.get(SystemMonitorService);
    const here = await monitor.status(now);
    expect(here.reasons).not.toContain('client_ip_private');
    expect(here.clientIp).toEqual({ proxiedRequests: 2, privateAddressRequests: 1, lastPrivateAt: now.toISOString() });
    expect(JSON.stringify(here.clientIp)).not.toContain('172.18');

    const prod = new SystemMonitorService(t.prisma, { ...testConfig(), APP_ENV: 'production' }, Reflect.get(monitor, 'flags'));
    expect((await prod.status(now)).reasons).toContain('client_ip_private');
    expect((await prod.status(new Date(now.getTime() + 2 * 3600_000))).reasons).not.toContain('client_ip_private');
    clientIpWatch.reset();
  });

  it('a request the web proxy forwards without a client address (a health check inside the container) is not counted (review round 1)', async () => {
    clientIpWatch.reset();
    // The proxy marks only requests it forwards a client address for (apps/web/src/lib/api-proxy.ts): no marker here.
    for (let i = 0; i < 5; i++) await t.http().get('/health').set('user-agent', 'node');
    expect([clientIpWatch.proxied, clientIpWatch.privateAddress]).toEqual([0, 0]);
    const monitor = t.app.get(SystemMonitorService);
    const prod = new SystemMonitorService(t.prisma, { ...testConfig(), APP_ENV: 'production' }, Reflect.get(monitor, 'flags'));
    expect((await prod.status()).reasons).not.toContain('client_ip_private');
    clientIpWatch.reset();
  });

  it('the middleware reads the marker the web proxy sets', async () => {
    clientIpWatch.reset();
    await t.http().get('/health');
    expect(clientIpWatch.proxied).toBe(0);
    await t.http().get('/health').set(PROXIED_HEADER, '1');
    // supertest connects from loopback: a proxied request from a private address.
    expect([clientIpWatch.proxied, clientIpWatch.privateAddress]).toEqual([1, 1]);
    clientIpWatch.reset();
  });
});
