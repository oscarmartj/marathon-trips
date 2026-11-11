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

  // Jobs: the API runs pg-boss workers unless this is "off" (used by tests and one-off scripts).
  JOBS_WORKERS: z.enum(['on', 'off']).default('on'),
  EVENTS_POLL_MS: z.coerce.number().int().min(100).default(2000),
});

type ParsedConfig = z.infer<typeof configSchema>;
export type AppConfig = Omit<ParsedConfig, 'EMAIL_HASH_KEY' | 'FILE_SIGNING_KEY'> & {
  EMAIL_HASH_KEY: string;
  FILE_SIGNING_KEY: string;
};

const DEV_ENVS: ReadonlyArray<string> = ['development', 'test', 'ci'];
// Not secrets: they exist so local work, tests and CI run without setup. Never used in staging or production.
const DEV_EMAIL_HASH_KEY = 'dev-only-email-hash-key-not-a-secret-0001';
const DEV_FILE_SIGNING_KEY = 'dev-only-file-signing-key-not-a-secret-01';

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
  if (missing.length > 0) throw new Error(`Invalid configuration: check ${missing.join(', ')}`);
  return {
    ...data,
    EMAIL_HASH_KEY: data.EMAIL_HASH_KEY ?? DEV_EMAIL_HASH_KEY,
    FILE_SIGNING_KEY: data.FILE_SIGNING_KEY ?? DEV_FILE_SIGNING_KEY,
  };
}
