import type { PermissionDef } from '../access/permissions';

// Task 8.4. Reading needs no step-up (no secrets are ever shown); every change needs a recent TOTP check, so an API key
// can never create keys or webhooks. None of these is API-key scopable.
export const INTEGRATIONS_PERMISSIONS = {
  apiKeyRead: 'integrations.apiKey.read',
  apiKeyManage: 'integrations.apiKey.manage',
  webhookRead: 'integrations.webhook.read',
  webhookManage: 'integrations.webhook.manage',
} as const;

export const INTEGRATIONS_PERMISSION_DEFS: readonly PermissionDef[] = [
  { key: INTEGRATIONS_PERMISSIONS.apiKeyRead, module: 'integrations', description: 'See API keys: name, prefix, scopes, owner, expiry and last use (never the secret)' },
  { key: INTEGRATIONS_PERMISSIONS.apiKeyManage, module: 'integrations', description: 'Create and revoke API keys', requiresStepUp: true },
  { key: INTEGRATIONS_PERMISSIONS.webhookRead, module: 'integrations', description: 'See outgoing webhooks and their deliveries (never the secret or the full address)' },
  { key: INTEGRATIONS_PERMISSIONS.webhookManage, module: 'integrations', description: 'Create, change, rotate, test and delete outgoing webhooks, and retry deliveries', requiresStepUp: true },
];

/** The integrations module flag: off = no API key authenticates, no webhook is sent, and these routes answer 404. */
export const INTEGRATIONS_MODULE = 'integrations';
