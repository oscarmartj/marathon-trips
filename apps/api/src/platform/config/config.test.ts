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
    const c = loadConfig({ ...base, APP_ENV: 'production', EMAIL_HASH_KEY: key, FILE_SIGNING_KEY: key });
    expect(c).toMatchObject({ MAIL_MODE: 'catch', SMTP_PORT: 1025, JOBS_WORKERS: 'on' });
  });
});
