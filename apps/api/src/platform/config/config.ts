import { appEnvSchema } from '@mt/shared';
import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65535);

const configSchema = z.object({
  // No default: the API refuses to start without it, so a missing variable can never mean "production-ish".
  APP_ENV: appEnvSchema,
  API_PORT: portSchema.default(4000),
  // The API's own role (mt_app). Migrations use MIGRATION_DATABASE_URL (mt_owner) via prisma.config.ts.
  DATABASE_URL: z.string().min(1),
});

export type AppConfig = z.infer<typeof configSchema>;

/** Validates environment variables; throws a readable error naming each bad variable (never its value). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid configuration: check ${names}`);
  }
  return parsed.data;
}
