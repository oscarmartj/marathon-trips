import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, checkDemoData, cookieJar, parseDemoCredentials, totp } from './check-compose-demo-data.mjs';

const LOG = [
  'api-1  | Applying migration `0004_auth`',
  'api-1  | Demo owner (development only):',
  'api-1  |   email:    owner@example.test',
  'api-1  |   password: Ab-9_xYz12345678',
  'api-1  |   TOTP:     JBSWY3DPEHPK3PXP',
  'api-1  |   otpauth:  otpauth://totp/Marathon%20Trips:owner%40example.test?secret=JBSWY3DPEHPK3PXP',
  'api-1  | API listening on 4000',
].join('\n');

test('credentials are read from compose-prefixed log lines', () => {
  assert.deepEqual(parseDemoCredentials(LOG), { email: 'owner@example.test', password: 'Ab-9_xYz12345678', secret: 'JBSWY3DPEHPK3PXP' });
});

test('no credentials block, or an incomplete one, gives null', () => {
  assert.equal(parseDemoCredentials('api-1  | API listening on 4000'), null);
  assert.equal(parseDemoCredentials('api-1  | Demo owner (development only):\napi-1  |   email:    owner@example.test'), null);
});

test('base32 and TOTP match the RFC 6238 vectors (SHA-1, 8 digits truncated to 6)', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totp(secret, 59_000), '287082');
  assert.equal(totp(secret, 1_111_111_109_000), '081804');
  assert.equal(totp(secret, 20_000_000_000_000), '353130');
});

test('cookie jar keeps the latest value and drops cleared cookies', () => {
  const jar = cookieJar(new Map(), ['a=1; Path=/; HttpOnly', 'b=2; Path=/']);
  cookieJar(jar, ['a=3; Path=/', 'b=; Path=/; Max-Age=0']);
  assert.deepEqual([...jar], [['a', '3']]);
});

/** A fake web app + API: signs in with the right password and code, then lists `tasks` rows. */
function fakeServer({ tasks = 6, password = 'Ab-9_xYz12345678', now = 59_000 } = {}) {
  const seen = [];
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    seen.push({ path, init });
    const reply = (status, json, cookies = []) => ({ status, text: async () => JSON.stringify(json), headers: { getSetCookie: () => cookies } });
    if (init.headers.origin !== 'http://web.test' || init.headers['x-mt-csrf'] !== '1') return reply(403, { code: 'csrf_rejected' });
    if (path === '/api/auth/staff/sign-in') return body.password === password ? reply(200, { next: 'second_factor' }, ['mt_staff_mfa=step; Path=/']) : reply(401, {});
    if (path === '/api/auth/staff/sign-in/second-factor') {
      return body.code === totp('JBSWY3DPEHPK3PXP', now) && init.headers.cookie.includes('mt_staff_mfa=step')
        ? reply(200, { signedIn: true }, ['mt_staff_mfa=; Max-Age=0', 'mt_staff_session=s; Path=/']) : reply(401, {});
    }
    if (!init.headers.cookie.includes('mt_staff_session=s')) return reply(401, {});
    if (path === '/api/auth/staff/session') return reply(200, { email: 'owner@example.test' });
    if (path === '/api/admin/tables/Task/rows') return reply(200, { total: tasks, rows: Array.from({ length: tasks }, (_, i) => ({ id: i })) });
    return reply(404, {});
  };
  return { fetchFn, seen };
}
const run = (server, logText = LOG) => checkDemoData({ logText, base: 'http://web.test', fetchFn: server.fetchFn, now: () => 59_000 });

test('everything present passes', async () => {
  const s = fakeServer();
  assert.deepEqual(await run(s), []);
  assert.ok(s.seen.every((r) => r.path.startsWith('/api/')));
});

test('missing credentials in the log fails', async () => {
  assert.match((await run(fakeServer(), 'api-1  | API listening on 4000'))[0], /did not run in development/);
});

test('a wrong password or a missing seed user fails sign-in', async () => {
  assert.match((await run(fakeServer({ password: 'other' })))[0], /Password sign-in .* 401/);
});

test('a wrong second factor fails', async () => {
  assert.match((await run(fakeServer({ now: 120_000 })))[0], /Second-factor .* 401/);
});

test('missing or extra demo tasks fail', async () => {
  assert.match((await run(fakeServer({ tasks: 0 }))).join('|'), /Task table has 0 rows/);
  assert.match((await run(fakeServer({ tasks: 7 }))).join('|'), /has 7 rows/);
});
