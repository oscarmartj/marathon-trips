import { z } from 'zod';
import { appEnvSchema } from './env';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  appEnv: appEnvSchema,
  database: z.enum(['up', 'down']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
