import { describe, expect, it } from 'vitest';
import { t } from './i18n';

describe('t', () => {
  it('returns an en-AU message with the brand name filled in from the brand config', () => {
    expect(t('home.title')).toBe('Marathon Trips');
  });
  it('fills named parameters', () => {
    expect(t('races.detail.title', { name: 'Sample Marathon' })).toBe('Sample Marathon');
  });
  it('throws on a missing key rather than rendering a blank', () => {
    expect(() => t('home.nope')).toThrow(/Missing message/);
  });
  it('throws on a missing parameter', () => {
    expect(() => t('races.detail.title')).toThrow(/Missing parameter/);
  });
});
