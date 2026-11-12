#!/usr/bin/env node
// compose_up_smoke_has_demo_data (task 0.fix-2): after `docker compose up --wait`, checks that the demo data exists.
//   1. The API log shows the demo owner's credentials (printed once by the seed, in development only).
//   2. The demo owner signs in with password and TOTP through the web app's /api proxy.
//   3. The example table (Task) lists the 6 demo rows.
// Usage: node scripts/check-compose-demo-data.mjs --logs <file with `docker compose logs --no-color api`> [--base http://localhost:3000]
// The credentials are development-only, but they are never printed here.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEMO_OWNER_EMAIL = 'owner@example.test';
export const DEMO_TASK_COUNT = 6;

/** Reads the block printed by prisma/seed/seed.ts. Compose prefixes each line with "api-1  | ". */
export function parseDemoCredentials(logText) {
  const lines = logText.split(/\r?\n/).map((l) => l.replace(/^\S+\s+\|\s?/, ''));
  const start = lines.findIndex((l) => l.includes('Demo owner (development only):'));
  if (start < 0) return null;
  const field = (name) => {
    for (const l of lines.slice(start + 1, start + 8)) {
      const m = l.match(new RegExp(`^\\s*${name}:\\s+(\\S+)\\s*$`));
      if (m) return m[1];
    }
    return undefined;
  };
  const creds = { email: field('email'), password: field('password'), secret: field('TOTP') };
  return creds.email && creds.password && creds.secret ? creds : null;
}

export function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of text.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error('Not a base32 secret');
    bits += i.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as the API expects. */
export function totp(secretBase32, nowMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const o = hmac[hmac.length - 1] & 0x0f;
  const n = ((hmac[o] & 0x7f) << 24) | (hmac[o + 1] << 16) | (hmac[o + 2] << 8) | hmac[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** "name=value" pairs from Set-Cookie headers, keeping the latest value per name and dropping cleared cookies. */
export function cookieJar(jar, setCookies) {
  for (const sc of setCookies) {
    const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const cleared = pair.slice(eq + 1) === '' || attrs.some((a) => /^max-age=0$/i.test(a));
    if (cleared) jar.delete(name);
    else jar.set(name, pair.slice(eq + 1));
  }
  return jar;
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** Returns the list of problems found (empty when the demo data is all there). */
export async function checkDemoData({ logText, base, fetchFn = fetch, now = Date.now }) {
  const creds = parseDemoCredentials(logText);
  if (!creds) return ['The api log has no "Demo owner" credentials block: the demo-staff seed did not run in development'];
  if (creds.email !== DEMO_OWNER_EMAIL) return [`The demo owner email is ${creds.email}, expected ${DEMO_OWNER_EMAIL}`];

  const jar = new Map();
  // Same origin as the browser: the API accepts changes only from WEB_ORIGIN and with the CSRF header.
  const call = async (method, path, body) => {
    const res = await fetchFn(`${base}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: base, 'x-mt-csrf': '1', cookie: cookieHeader(jar) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    cookieJar(jar, res.headers.getSetCookie?.() ?? []);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json };
  };

  const first = await call('POST', '/auth/staff/sign-in', { email: creds.email, password: creds.password });
  if (first.status !== 200 || first.json?.next !== 'second_factor') return [`Password sign-in through the web proxy returned ${first.status}`];
  const second = await call('POST', '/auth/staff/sign-in/second-factor', { code: totp(creds.secret, now()) });
  if (second.status !== 200 || second.json?.signedIn !== true) return [`Second-factor sign-in through the web proxy returned ${second.status}`];
  const session = await call('GET', '/auth/staff/session');
  if (session.status !== 200 || session.json?.email !== DEMO_OWNER_EMAIL) return [`The staff session check returned ${session.status}`];

  const tasks = await call('GET', '/admin/tables/Task/rows?pageSize=50');
  if (tasks.status !== 200) return [`Listing the Task table returned ${tasks.status}`];
  const problems = [];
  if (tasks.json?.total !== DEMO_TASK_COUNT) problems.push(`The Task table has ${tasks.json?.total} rows, expected ${DEMO_TASK_COUNT}`);
  if (!Array.isArray(tasks.json?.rows) || tasks.json.rows.length !== DEMO_TASK_COUNT) problems.push(`The Task list returned ${tasks.json?.rows?.length} rows, expected ${DEMO_TASK_COUNT}`);
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const logs = arg('--logs');
  if (!logs) { console.error('Usage: check-compose-demo-data.mjs --logs <file> [--base <url>]'); process.exit(2); }
  const problems = await checkDemoData({ logText: readFileSync(logs, 'utf8'), base: arg('--base', 'http://localhost:3000') });
  if (problems.length) { for (const p of problems) console.error(`FAIL: ${p}`); process.exit(1); }
  console.log(`compose_up_smoke_has_demo_data: ok (credentials in the api log, staff sign-in through /api, ${DEMO_TASK_COUNT} demo tasks)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
