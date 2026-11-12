import { createHmac, randomBytes } from 'node:crypto';

/**
 * Standard Webhooks signatures (https://www.standardwebhooks.com, task 8.4): HMAC-SHA256 over `${id}.${timestamp}.${body}`
 * with the secret's bytes (base64 after `whsec_`), sent as `v1,<base64>`. Several signatures are space separated, so a
 * receiver accepts either secret during a rotation.
 */
export const WEBHOOK_SECRET = /^whsec_([A-Za-z0-9+/]{43}=)$/;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

export function signWebhook(secret: string, id: string, timestampSeconds: number, body: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestampSeconds}.${body}`).digest('base64')}`;
}

export function signatureHeader(secrets: readonly string[], id: string, timestampSeconds: number, body: string): string {
  return secrets.map((s) => signWebhook(s, id, timestampSeconds, body)).join(' ');
}
