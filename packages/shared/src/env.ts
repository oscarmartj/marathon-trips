import { z } from 'zod';

/** Where the app is running. Required: the API refuses to start without it. */
export const APP_ENVS = ['development', 'test', 'ci', 'staging', 'production'] as const;
export const appEnvSchema = z.enum(APP_ENVS);
export type AppEnv = z.infer<typeof appEnvSchema>;
