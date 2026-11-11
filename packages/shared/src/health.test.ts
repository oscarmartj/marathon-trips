import { describe, expect, it } from 'vitest';
import { appEnvSchema, healthResponseSchema } from './index';

describe('shared schemas', () => {
  it('rejects an unknown APP_ENV', () => {
    expect(appEnvSchema.safeParse('prod').success).toBe(false);
    expect(appEnvSchema.safeParse('production').success).toBe(true);
  });
  it('validates a health response', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', appEnv: 'test', database: 'up' }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ status: 'fine', appEnv: 'test', database: 'up' }).success).toBe(false);
  });
});
