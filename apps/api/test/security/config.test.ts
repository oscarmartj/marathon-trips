import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config/config';

// Task 8.5 (S-05): outside development, test and ci, the API refuses configurations that would run with published keys,
// with one key reused for two purposes, with every address trusted as a proxy, or with a plain-http web origin.
const key = () => randomBytes(32).toString('base64url');
const good = () => ({
  APP_ENV: 'production', DATABASE_URL: 'postgresql://mt_app:x@db:5432/marathon_trips', WEB_ORIGIN: 'https://trips.example.com',
  EMAIL_HASH_KEY: key(), FILE_SIGNING_KEY: key(), AUTH_HMAC_KEY: key(), APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  TRUST_PROXY: 'uniquelocal',
});
const refused = (env: Record<string, string>, name: string) => expect(() => loadConfig(env)).toThrow(new RegExp(`check .*${name}`));

describe('production configuration refusals (S-05)', () => {
  it('a complete production configuration loads, and no error ever shows a value', () => {
    const env = good();
    expect(loadConfig(env).WEB_ORIGIN).toBe('https://trips.example.com');
    try {
      loadConfig({ ...env, AUTH_HMAC_KEY: env.EMAIL_HASH_KEY });
    } catch (e) {
      expect(String(e)).not.toContain(env.EMAIL_HASH_KEY);
    }
  });

  it.each(['production', 'staging'])('refuses the published dev-only keys in %s', (APP_ENV) => {
    refused({ ...good(), APP_ENV, EMAIL_HASH_KEY: 'dev-only-email-hash-key-not-a-secret-0001' }, 'EMAIL_HASH_KEY');
    refused({ ...good(), APP_ENV, FILE_SIGNING_KEY: 'dev-only-file-signing-key-not-a-secret-01' }, 'FILE_SIGNING_KEY');
    refused({ ...good(), APP_ENV, AUTH_HMAC_KEY: 'dev-only-auth-hmac-key-not-a-secret-00001' }, 'AUTH_HMAC_KEY');
    refused({ ...good(), APP_ENV, APP_ENCRYPTION_KEY: Buffer.from('dev-only-encryption-key-32-bytes').toString('base64') }, 'APP_ENCRYPTION_KEY');
  });

  it('refuses one value used for two keys', () => {
    const env = good();
    refused({ ...env, AUTH_HMAC_KEY: env.EMAIL_HASH_KEY }, 'AUTH_HMAC_KEY');
    refused({ ...env, FILE_SIGNING_KEY: env.AUTH_HMAC_KEY }, 'FILE_SIGNING_KEY');
  });

  it('refuses TRUST_PROXY=true, which would let any client choose its address', () => {
    refused({ ...good(), TRUST_PROXY: 'true' }, 'TRUST_PROXY');
    expect(loadConfig({ ...good(), TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
  });

  it('refuses a web origin that is not https', () => {
    refused({ ...good(), WEB_ORIGIN: 'http://trips.example.com' }, 'WEB_ORIGIN');
  });

  it('development keeps its defaults, http://localhost and TRUST_PROXY=true', () => {
    const c = loadConfig({ APP_ENV: 'development', DATABASE_URL: 'postgresql://x', TRUST_PROXY: 'true' });
    expect(c.WEB_ORIGIN).toBe('http://localhost:3000');
    expect(c.TRUST_PROXY).toBe(true);
  });
});
