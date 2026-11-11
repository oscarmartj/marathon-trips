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
