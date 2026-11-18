import { describe, expect, it } from 'vitest';
import { formatMinor } from '../../../src/modules/payments/core/format';

describe('formatMinor follows the currency decimals', () => {
  it.each([
    [123456n, 'AUD', 'A$1,234.56'], [5n, 'AUD', 'A$0.05'], [0n, 'AUD', 'A$0.00'], [-250n, 'AUD', '-A$2.50'],
    [123456n, 'JPY', 'JPY 123,456'], [7n, 'JPY', 'JPY 7'], [1234567n, 'KWD', 'KWD 1,234.567'], [5n, 'KWD', 'KWD 0.005'],
  ])('%s %s -> %s', (minor, currency, expected) => {
    expect(formatMinor(minor, currency)).toBe(expected);
  });
});
