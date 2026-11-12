import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyAddress, pickAddress, validateWebhookUrl } from '../../src/platform/integrations/ssrf';
import { buildOutboundBody, WEBHOOK_EVENT_CATALOGUE } from '../../src/platform/integrations/webhook-catalogue';
import { devAllowlist } from '../../src/platform/integrations/webhook-delivery.service';
import { newWebhookSecret, signatureHeader, signWebhook, WEBHOOK_SECRET } from '../../src/platform/integrations/webhook-signing';
import { maskUrl } from '../../src/platform/integrations/webhooks.service';

const prod = { production: true, ownHost: 'marathontrips.example' };
const dev = { production: false, ownHost: 'localhost' };

describe('SSRF rules (task 8.4, plan 4.4 and 11.5)', () => {
  it('webhook_ssrf_blocked_addresses', () => {
    const table: Array<[string, 'public' | 'loopback' | 'blocked']> = [
      ['8.8.8.8', 'public'], ['1.1.1.1', 'public'], ['93.184.216.34', 'public'],
      ['0.0.0.0', 'blocked'], ['10.0.0.5', 'blocked'], ['100.64.1.1', 'blocked'], ['127.0.0.1', 'loopback'], ['127.9.9.9', 'loopback'],
      ['169.254.169.254', 'blocked'], ['172.16.0.1', 'blocked'], ['172.31.255.255', 'blocked'], ['192.0.0.8', 'blocked'], ['192.0.2.1', 'blocked'],
      ['192.88.99.1', 'blocked'], ['192.168.1.1', 'blocked'], ['198.18.0.1', 'blocked'], ['198.51.100.1', 'blocked'], ['203.0.113.1', 'blocked'],
      ['224.0.0.1', 'blocked'], ['240.0.0.1', 'blocked'], ['255.255.255.255', 'blocked'],
      ['2606:4700:4700::1111', 'public'], ['2a00:1450:4001:80b::200e', 'public'],
      ['::', 'blocked'], ['::1', 'loopback'], ['::8.8.8.8', 'blocked'], ['::ffff:127.0.0.1', 'blocked'], ['::ffff:169.254.169.254', 'blocked'],
      ['::ffff:8.8.8.8', 'blocked'], ['::ffff:0:808:808', 'blocked'], ['64:ff9b::808:808', 'blocked'], ['64:ff9b:1::1', 'blocked'], ['100::1', 'blocked'],
      ['2001::1', 'blocked'], ['2001:db8::1', 'blocked'], ['2002:c0a8:101::1', 'blocked'], ['fc00::1', 'blocked'], ['fd12::1', 'blocked'],
      ['fe80::1', 'blocked'], ['fec0::1', 'blocked'], ['ff02::1', 'blocked'], ['3fff::1', 'blocked'], ['not-an-ip', 'blocked'],
    ];
    for (const [ip, want] of table) expect(classifyAddress(ip), ip).toBe(want);
  });

  it('webhook_url_validation', () => {
    const bad: Array<[string, typeof prod]> = [
      ['ftp://hooks.example.com/x', dev], ['https://user:pw@hooks.example.com/x', dev], ['https://hooks.example.com/x#frag', dev],
      [`https://hooks.example.com/${'a'.repeat(2048)}`, dev], ['not a url', dev], ['http://hooks.example.com/x', prod],
      ['https://hooks.example.com:8443/x', prod], ['https://10.0.0.5/x', dev], ['https://169.254.169.254/latest', dev],
      ['http://0x7f000001/', prod], ['http://2130706433/', prod], ['http://127.1/', prod], ['https://0x7f000001/', prod], ['https://2130706433/', prod],
      ['https://127.1/', prod], ['https://[::ffff:169.254.169.254]/', dev], ['https://[::ffff:169.254.169.254]/', prod], ['https://localhost./x', prod],
      ['https://localhost/x', prod], ['https://intranet/x', prod], ['https://marathontrips.example/api/x', prod], ['https://marathontrips.example./x', prod],
      ['https://[fd00::1]/x', dev], ['https://[::1]/x', prod], ['https://127.0.0.1/x', prod],
      // The host of WEB_ORIGIN (localhost in development) is never a target, whatever the port.
      ['http://localhost:4567/hook', dev],
    ];
    for (const [url, rules] of bad) expect(() => validateWebhookUrl(url, rules), url).toThrow(/not allowed/);
    const good: Array<[string, typeof prod]> = [
      ['https://hooks.example.com/x?token=abc', prod], ['https://hooks.example.com:443/x', prod], ['http://127.0.0.1:4567/hook', dev],
      ['https://[2606:4700::1]/x', prod],
    ];
    for (const [url, rules] of good) expect(() => validateWebhookUrl(url, rules), url).not.toThrow();
  });

  it('webhook_any_private_resolved_address_blocks', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }, { address: '10.0.0.7', family: 4 as const }];
    await expect(pickAddress('mixed.example', resolver, false)).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(pickAddress('mixed.example', resolver, true)).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(pickAddress('ok.example', async () => [{ address: '93.184.216.34', family: 4 }], false)).resolves.toEqual({ address: '93.184.216.34', family: 4 });
    await expect(pickAddress('none.example', async () => [], false)).rejects.toMatchObject({ code: 'dns_failed' });
    await expect(pickAddress('err.example', async () => { throw new Error('ENOTFOUND 10.1.1.1'); }, false)).rejects.toMatchObject({ code: 'dns_failed' });
  });

  it('a dev allow-listed origin that resolves to 10.x is still blocked; only loopback is let through', async () => {
    await expect(pickAddress('internal.test', async () => [{ address: '10.0.0.5', family: 4 }], true)).rejects.toMatchObject({ code: 'blocked_address' });
    await expect(pickAddress('localhost', async () => [{ address: '127.0.0.1', family: 4 }], true)).resolves.toMatchObject({ address: '127.0.0.1' });
  });

  it('production_blocks_loopback_even_if_allowlisted', async () => {
    const allow = devAllowlist({ APP_ENV: 'production', WEBHOOK_DEV_ALLOWLIST: 'http://127.0.0.1:4567' });
    expect(allow.origins.size).toBe(0);
    const allowLoopback = allow.origins.has('http://127.0.0.1:4567');
    await expect(pickAddress('127.0.0.1', async () => [], allowLoopback)).rejects.toMatchObject({ code: 'blocked_address' });
    expect(() => validateWebhookUrl('http://127.0.0.1:4567/x', prod)).toThrow();
  });

  it('webhook_dev_allowlist_ignored_in_production, with a warning', () => {
    expect(devAllowlist({ APP_ENV: 'production', WEBHOOK_DEV_ALLOWLIST: 'http://127.0.0.1:1' }).warning).toMatch(/ignored/);
    expect(devAllowlist({ APP_ENV: 'production', WEBHOOK_DEV_ALLOWLIST: '' }).warning).toBeUndefined();
    expect([...devAllowlist({ APP_ENV: 'staging', WEBHOOK_DEV_ALLOWLIST: 'http://127.0.0.1:1, bad url ,https://hooks.example.com/path' }).origins])
      .toEqual(['http://127.0.0.1:1', 'https://hooks.example.com']);
  });
});

describe('signatures (Standard Webhooks)', () => {
  it('webhook_signature_matches_standard_webhooks_vector', () => {
    // Example from the Standard Webhooks specification and its reference libraries.
    expect(signWebhook('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'))
      .toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('secrets are 32 random bytes and several signatures are space separated', () => {
    const a = newWebhookSecret();
    const b = newWebhookSecret();
    expect(a).toMatch(WEBHOOK_SECRET);
    expect(a).not.toBe(b);
    expect(Buffer.from(a.slice(6), 'base64')).toHaveLength(32);
    const header = signatureHeader([a, b], 'id1', 10, '{}');
    const expected = (s: string) => `v1,${createHmac('sha256', Buffer.from(s.slice(6), 'base64')).update('id1.10.{}').digest('base64')}`;
    expect(header).toBe(`${expected(a)} ${expected(b)}`);
  });
});

describe('outgoing contract', () => {
  const base = { id: '0190f2f4-0000-7000-8000-000000000001', schemaVersion: 1, aggregateType: 'Package', aggregateId: '0190f2f4-0000-7000-8000-000000000002', aggregateVersion: 3, occurredAt: new Date('2027-01-02T03:04:05Z') };
  const ids = { packageId: '0190f2f4-0000-7000-8000-000000000002', editionId: '0190f2f4-0000-7000-8000-000000000003', raceId: '0190f2f4-0000-7000-8000-000000000004' };

  it('webhook_payload_matches_outbound_contract: fields are picked, extras dropped, no actor', () => {
    const body = buildOutboundBody({ ...base, type: 'catalogue.package.sale_status_changed', payload: { ...ids, fromStatus: 'coming_soon', toStatus: 'open', internalNote: 'x', actorId: 'y' } });
    expect(body).toEqual({
      type: 'catalogue.package.sale_status_changed', timestamp: '2027-01-02T03:04:05.000Z',
      data: { eventId: base.id, schemaVersion: 1, aggregateType: 'Package', aggregateId: base.aggregateId, aggregateVersion: 3, ...ids, fromStatus: 'coming_soon', toStatus: 'open' },
    });
    expect(JSON.stringify(body)).not.toMatch(/internalNote|actor/);
  });

  it('a missing or malformed contract field throws with the field names only', () => {
    expect(() => buildOutboundBody({ ...base, type: 'catalogue.package.sale_status_changed', payload: { ...ids, fromStatus: 'x' } })).toThrow(/toStatus/);
    expect(() => buildOutboundBody({ ...base, type: 'catalogue.package.sale_status_changed', payload: { ...ids, fromStatus: 'Secret Value!', toStatus: 'open' } })).toThrow(/fromStatus/);
    try {
      buildOutboundBody({ ...base, type: 'catalogue.package.sale_status_changed', payload: { ...ids, fromStatus: 'Secret Value!', toStatus: 'open' } });
    } catch (e) {
      expect((e as Error).message).not.toContain('Secret Value');
    }
    expect(() => buildOutboundBody({ ...base, type: 'auth.user.logged_in', payload: {} })).toThrow(/catalogue/);
  });

  it('every catalogue entry declares a read permission and excludes people and sessions', () => {
    for (const e of WEBHOOK_EVENT_CATALOGUE) {
      expect(e.readPermission).toMatch(/^[a-z]+\.[a-zA-Z]+\.read$/);
      expect(Object.keys(e.data.shape).join(',')).not.toMatch(/user|session|email|customer|name/i);
      expect(e.type).not.toMatch(/^(auth|access|common|payments|bookings)\./);
    }
  });

  it('listings mask the address', () => {
    expect(maskUrl('https://hooks.example.com/abc/secret-token?x=1')).toBe('https://hooks.example.com/…');
    expect(maskUrl('https://hooks.example.com/')).toBe('https://hooks.example.com/');
    expect(maskUrl('https://hooks.example.com/?token=1')).toBe('https://hooks.example.com/…');
  });
});
