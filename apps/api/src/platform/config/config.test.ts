import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgresql://mt_app@localhost/marathon_trips' };

describe('loadConfig', () => {
  it('refuses to start without APP_ENV', () => {
    expect(() => loadConfig({ ...base })).toThrow(/APP_ENV/);
  });
  it('rejects an unknown APP_ENV', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'prod' })).toThrow(/APP_ENV/);
  });
  it('does not echo secret values in the error', () => {
    expect(() => loadConfig({ APP_ENV: 'test', DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
  it('accepts a valid environment and applies defaults', () => {
    expect(loadConfig({ ...base, APP_ENV: 'test' })).toMatchObject({ APP_ENV: 'test', API_PORT: 4000 });
  });
});

describe('loadConfig platform settings', () => {
  it('uses development keys only in development, test and ci', () => {
    expect(loadConfig({ ...base, APP_ENV: 'ci' }).EMAIL_HASH_KEY.length).toBeGreaterThanOrEqual(32);
    expect(() => loadConfig({ ...base, APP_ENV: 'production' })).toThrow(/EMAIL_HASH_KEY, FILE_SIGNING_KEY/);
    expect(() => loadConfig({ ...base, APP_ENV: 'staging' })).toThrow(/EMAIL_HASH_KEY/);
  });
  it('accepts real keys in production and keeps mail on a dev mailbox by default', () => {
    const key = 'k'.repeat(40);
    const c = loadConfig({ ...base, APP_ENV: 'production', EMAIL_HASH_KEY: key, FILE_SIGNING_KEY: key, ...authKeys });
    expect(c).toMatchObject({ MAIL_MODE: 'catch', SMTP_PORT: 1025, JOBS_WORKERS: 'on' });
  });
});

const authKeys = { APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AUTH_HMAC_KEY: 'h'.repeat(40) };
const prodKeys = { EMAIL_HASH_KEY: 'k'.repeat(40), FILE_SIGNING_KEY: 'k'.repeat(40) };

describe('loadConfig auth settings (task 0.3)', () => {
  it('requires the encryption and HMAC keys outside development, test and ci', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'production', ...prodKeys })).toThrow(/APP_ENCRYPTION_KEY, AUTH_HMAC_KEY/);
    expect(loadConfig({ ...base, APP_ENV: 'production', ...prodKeys, ...authKeys }).APP_ENCRYPTION_KEY).toHaveLength(32);
  });
  it('rejects an encryption key that is not base64 of 32 bytes, without echoing it', () => {
    let message = '';
    try {
      loadConfig({ ...base, APP_ENV: 'test', APP_ENCRYPTION_KEY: 'c2hvcnQ=' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/APP_ENCRYPTION_KEY/);
    expect(message).not.toContain('c2hvcnQ=');
  });
  it('cookie_secure_required_outside_dev', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'staging', ...prodKeys, ...authKeys, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...base, APP_ENV: 'production', ...prodKeys, ...authKeys, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(loadConfig({ ...base, APP_ENV: 'production', ...prodKeys, ...authKeys }).COOKIE_SECURE).toBe(true);
    expect(loadConfig({ ...base, APP_ENV: 'development' }).COOKIE_SECURE).toBe(false);
    expect(loadConfig({ ...base, APP_ENV: 'development', COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
  });
  it('trusts no proxy by default', () => {
    expect(loadConfig({ ...base, APP_ENV: 'test' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...base, APP_ENV: 'test', TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...base, APP_ENV: 'test', TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe('loopback');
  });
});
