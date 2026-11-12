import { z } from 'zod';

// Request bodies of the integrations routes (task 8.4), shared by the API and the panel. Strict: an unknown field is a 422.

const permissionKey = z.string().regex(/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/);
const eventType = z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/).max(100);

export const API_KEY_MAX_DAYS = 365;
export const API_KEY_DEFAULT_DAYS = 90;

export const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(permissionKey).min(1).max(50).refine((a) => new Set(a).size === a.length, { message: 'Each scope once' }),
    expiresInDays: z.number().int().min(1).max(API_KEY_MAX_DAYS).default(API_KEY_DEFAULT_DAYS),
  })
  .strict();

export const createWebhookSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    description: z.string().trim().max(200).default(''),
    eventTypes: z.array(eventType).min(1).max(50).refine((a) => new Set(a).size === a.length, { message: 'Each event type once' }),
  })
  .strict();

export const updateWebhookSchema = z
  .object({
    url: z.string().trim().min(1).max(2048).optional(),
    description: z.string().trim().max(200).optional(),
    eventTypes: z.array(eventType).min(1).max(50).refine((a) => new Set(a).size === a.length, { message: 'Each event type once' }).optional(),
    enabled: z.boolean().optional(),
    version: z.number().int().min(0),
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
