import { describe, expect, it } from 'vitest';
import { t } from './i18n';

describe('t', () => {
  it('returns an en-AU message', () => {
    expect(t('home.title')).toBe('Marathon Trips');
  });
  it('throws on a missing key rather than rendering a blank', () => {
    expect(() => t('home.nope')).toThrow(/Missing message/);
  });
});
