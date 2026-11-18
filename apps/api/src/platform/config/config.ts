import { appEnvSchema } from '@mt/shared';
import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65535);

const configSchema = z.object({
  // No default: the API refuses to start without it, so a missing variable can never mean "production-ish".
  APP_ENV: appEnvSchema,
  API_PORT: portSchema.default(4000),
  // The API's own role (mt_app). Migrations use MIGRATION_DATABASE_URL (mt_owner) via prisma.config.ts.
  DATABASE_URL: z.string().min(1),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),

  // Mail (plan 4.6). MAIL_MODE=live only counts together with APP_ENV=production (see mail guard);
  // any other value, including a typo, is treated as "not live".
  MAIL_MODE: z.string().default('catch'),
  MAIL_FROM: z.string().min(3).default('Marathon Trips <no-reply@example.test>'),
  MAIL_DEV_ALLOWLIST: z.string().default('example.test,example.com'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: portSchema.default(1025),

  // Keys. Development defaults exist only for development, test and ci; elsewhere they are required.
  EMAIL_HASH_KEY: z.string().min(32).optional(),
  FILE_SIGNING_KEY: z.string().min(32).optional(),

  // Files (plan 4.6): the filesystem adapter's root and the size limit.
  FILE_STORAGE_DIR: z.string().min(1).default('./var/files'),
  FILE_MAX_BYTES: z.coerce.number().int().min(1).default(10 * 1024 * 1024),

  // Auth (task 0.3). The browser talks only to the web app, which proxies /api; WEB_ORIGIN is the only accepted Origin.
  // Required outside development, test and ci (no default that could point at the wrong site).
  WEB_ORIGIN: z.string().url().optional(),
  // AES-256-GCM key for secrets at rest (TOTP secrets now, gateway credentials later): base64 of 32 bytes.
  APP_ENCRYPTION_KEY: z.string().optional(),
  APP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  // HMAC key for recovery codes.
  AUTH_HMAC_KEY: z.string().min(32).optional(),
  // Express "trust proxy": false (default) ignores X-Forwarded-For; a hop count or address list trusts that proxy.
  TRUST_PROXY: z.string().default('false'),
  // Cookies are Secure unless explicitly turned off, which only development, test and ci accept.
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  // Requests per minute and IP on sign-in, code and magic-link routes.
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  // Task 8.5 (S-06): staff sign-in attempts one client (IPv4 address or IPv6 /64) may make per hour, renewals included.
  AUTH_SIGN_IN_ATTEMPTS_PER_HOUR_PER_CLIENT: z.coerce.number().int().min(1).default(30),

  // Task 8.4. Outgoing webhooks outside production go only to these exact origins (scheme://host:port, comma separated);
  // in production the list is ignored with a warning at start-up. Empty by default.
  WEBHOOK_DEV_ALLOWLIST: z.string().default(''),
  // Requests per minute per API key, and failed API key authentications per minute per IP.
  API_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  API_KEY_FAILED_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  // Task 2.4: booking requests per hour, per customer and per IP (in memory, like the other limits).
  BOOKING_REQUESTS_PER_HOUR_PER_USER: z.coerce.number().int().min(1).default(10),
  BOOKING_REQUESTS_PER_HOUR_PER_IP: z.coerce.number().int().min(1).default(30),
  // Task 3.1: payment attempts per hour, per customer and per IP; incoming gateway webhooks per minute and IP (checked
  // before the body is read).
  PAYMENT_ATTEMPTS_PER_HOUR_PER_USER: z.coerce.number().int().min(1).default(10),
  PAYMENT_ATTEMPTS_PER_HOUR_PER_IP: z.coerce.number().int().min(1).default(30),
  PAYMENT_WEBHOOKS_PER_MINUTE_PER_IP: z.coerce.number().int().min(1).default(600),

  // Task 8.6: file written by scripts/backup/backup.sh after each good backup; the system monitor reads it. Optional.
  BACKUP_STATUS_FILE: z.string().min(1).optional(),

  // Jobs: the API runs pg-boss workers unless this is "off" (used by tests and one-off scripts).
  JOBS_WORKERS: z.enum(['on', 'off']).default('on'),
  EVENTS_POLL_MS: z.coerce.number().int().min(100).default(2000),
});

type ParsedConfig = z.infer<typeof configSchema>;
export type AppConfig = Omit<ParsedConfig, 'EMAIL_HASH_KEY' | 'FILE_SIGNING_KEY' | 'APP_ENCRYPTION_KEY' | 'AUTH_HMAC_KEY' | 'COOKIE_SECURE' | 'TRUST_PROXY' | 'WEB_ORIGIN'> & {
  WEB_ORIGIN: string;
  EMAIL_HASH_KEY: string;
  FILE_SIGNING_KEY: string;
  APP_ENCRYPTION_KEY: Buffer;
  AUTH_HMAC_KEY: string;
  COOKIE_SECURE: boolean;
  TRUST_PROXY: boolean | number | string;
};

const DEV_ENVS: ReadonlyArray<string> = ['development', 'test', 'ci'];
// Not secrets: they exist so local work, tests and CI run without setup. Never used in staging or production.
const DEV_EMAIL_HASH_KEY = 'dev-only-email-hash-key-not-a-secret-0001';
const DEV_FILE_SIGNING_KEY = 'dev-only-file-signing-key-not-a-secret-01';
const DEV_ENCRYPTION_KEY = Buffer.from('dev-only-encryption-key-32-bytes').toString('base64');
const DEV_AUTH_HMAC_KEY = 'dev-only-auth-hmac-key-not-a-secret-00001';

function encryptionKey(b64: string): Buffer | null {
  const key = Buffer.from(b64, 'base64');
  return key.length === 32 && key.toString('base64') === b64 ? key : null;
}

function trustProxy(v: string): boolean | number | string {
  if (v === 'false' || v === '') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // address list or preset such as loopback, uniquelocal
}

const DEV_KEYS: Record<string, string> = {
  EMAIL_HASH_KEY: DEV_EMAIL_HASH_KEY, FILE_SIGNING_KEY: DEV_FILE_SIGNING_KEY, AUTH_HMAC_KEY: DEV_AUTH_HMAC_KEY, APP_ENCRYPTION_KEY: DEV_ENCRYPTION_KEY,
};

const PRESETS = new Set(['false', '', 'loopback', 'linklocal', 'uniquelocal']);

/**
 * Task 8.5 (S-05, review round 1): a TRUST_PROXY that names the proxies in front, never one that trusts (almost) every
 * address: not `true`, not more than three hops, no unspecified address and no range wider than /8 (IPv4) or /16 (IPv6).
 */
export function narrowTrustProxy(value: string): boolean {
  if (PRESETS.has(value)) return true;
  if (/^\d+$/.test(value)) return Number(value) >= 1 && Number(value) <= 3;
  return value.split(',').map((e) => e.trim()).every((entry) => {
    if (!entry) return false;
    if (PRESETS.has(entry) && entry !== 'false' && entry !== '') return true;
    const [addr = '', bits] = entry.split('/');
    if (addr === '0.0.0.0' || addr === '::' || /^[0:]+$/.test(addr)) return false;
    const v6 = addr.includes(':');
    if (!v6 && !/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return false;
    const groups = v6 ? ipv6Groups(addr) : null;
    if (v6 && !groups) return false;
    if (bits === undefined) return true;
    if (!/^\d+$/.test(bits)) return false;
    const n = Number(bits);
    if (!v6) return n >= 8 && n <= 32;
    if (n < 16 || n > 128) return false;
    // Review round 2: proxy-addr matches an IPv4 client against an IPv6 range through its IPv4-mapped form
    // (::ffff:a.b.c.d), so ::ffff:0:0/96 trusts every IPv4 address and ::1/16 covers the whole mapped block. A range
    // whose first min(bits, 80) bits are all zero reaches that block: it needs /104 or narrower (an IPv4 /8 at most).
    const zeroPrefix = groups!.slice(0, Math.ceil(Math.min(n, 80) / 16)).every((g, i) => (i < Math.floor(Math.min(n, 80) / 16) ? g === 0 : g >> (16 - (Math.min(n, 80) % 16)) === 0));
    return !(zeroPrefix && n < 104);
  });
}

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail included), or null if it is not one. */
function ipv6Groups(addr: string): number[] | null {
  let text = addr.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    text = `${text.slice(0, v4.index)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(text) || (text.match(/::/g) ?? []).length > 1) return null;
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0 || (tail === undefined && left.length !== 8)) return null;
  const parts = [...left, ...Array(fill).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

/**
 * Task 8.5 (S-05): outside development, test and ci, the published dev-only keys, one value for two keys, a proxy setting
 * that trusts every address (any client could then choose its own IP) and a web origin without TLS are all refused.
 */
function productionRefusals(data: ParsedConfig): string[] {
  const bad: string[] = [];
  const seen = new Map<string, string>();
  for (const name of Object.keys(DEV_KEYS) as Array<keyof typeof DEV_KEYS & keyof ParsedConfig>) {
    const value = data[name] as string | undefined;
    if (!value) continue;
    if (value === DEV_KEYS[name]) bad.push(name);
    const other = seen.get(value);
    if (other) bad.push(other, name);
    seen.set(value, name);
  }
  if (!narrowTrustProxy(data.TRUST_PROXY)) bad.push('TRUST_PROXY');
  if (data.WEB_ORIGIN && new URL(data.WEB_ORIGIN).protocol !== 'https:') bad.push('WEB_ORIGIN');
  return bad;
}

/** Validates environment variables; throws a readable error naming each bad variable (never its value). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid configuration: check ${names}`);
  }
  const data = parsed.data;
  const dev = DEV_ENVS.includes(data.APP_ENV);
  const missing: string[] = [];
  if (!data.EMAIL_HASH_KEY && !dev) missing.push('EMAIL_HASH_KEY');
  if (!data.FILE_SIGNING_KEY && !dev) missing.push('FILE_SIGNING_KEY');
  if (!data.APP_ENCRYPTION_KEY && !dev) missing.push('APP_ENCRYPTION_KEY');
  if (!data.AUTH_HMAC_KEY && !dev) missing.push('AUTH_HMAC_KEY');
  if (!data.WEB_ORIGIN && !dev) missing.push('WEB_ORIGIN');
  const encKey = encryptionKey(data.APP_ENCRYPTION_KEY ?? DEV_ENCRYPTION_KEY);
  if (!encKey) missing.push('APP_ENCRYPTION_KEY');
  // Cookies without Secure only where everything runs on http://localhost (plan 4.1).
  if (data.COOKIE_SECURE === 'false' && !dev) missing.push('COOKIE_SECURE');
  if (!dev) missing.push(...productionRefusals(data));
  if (missing.length > 0) throw new Error(`Invalid configuration: check ${[...new Set(missing)].join(', ')}`);
  return {
    ...data,
    EMAIL_HASH_KEY: data.EMAIL_HASH_KEY ?? DEV_EMAIL_HASH_KEY,
    FILE_SIGNING_KEY: data.FILE_SIGNING_KEY ?? DEV_FILE_SIGNING_KEY,
    APP_ENCRYPTION_KEY: encKey!,
    AUTH_HMAC_KEY: data.AUTH_HMAC_KEY ?? DEV_AUTH_HMAC_KEY,
    WEB_ORIGIN: data.WEB_ORIGIN ?? 'http://localhost:3000',
    COOKIE_SECURE: data.COOKIE_SECURE ? data.COOKIE_SECURE === 'true' : !dev,
    TRUST_PROXY: trustProxy(data.TRUST_PROXY),
  };
}
