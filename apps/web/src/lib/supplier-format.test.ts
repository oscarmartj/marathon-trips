import { describe, expect, it } from 'vitest';
import { formatMinor, fromMinor, toMinor } from './supplier-format';

describe('supplier amounts', () => {
  it('formats minor units with the currency code and the right number of decimals', () => {
    expect(formatMinor('95050', 'DKK')).toMatch(/DKK\s?950\.50/);
    expect(formatMinor('5', 'AUD')).toMatch(/AUD\s?0\.05/);
    expect(formatMinor('1500', 'JPY')).toMatch(/JPY\s?1,500/);
    expect(formatMinor('1234', 'KWD')).toMatch(/KWD\s?1\.234/);
  });

  it('keeps every digit of a very large amount', () => {
    expect(formatMinor('100000000000000000', 'AUD')).toContain('1,000,000,000,000,000.00');
  });

  it('turns typed amounts into minor units, table', () => {
    const rows: Array<[string, string, string | null]> = [
      ['950.50', 'DKK', '95050'], ['950.5', 'DKK', '95050'], ['950', 'DKK', '95000'], ['1,200', 'AUD', '120000'], ['0.05', 'AUD', '5'], ['0', 'AUD', '0'],
      ['950.555', 'AUD', null], ['-5', 'AUD', null], ['abc', 'AUD', null], ['', 'AUD', null], ['1500', 'JPY', '1500'], ['1500.5', 'JPY', null], ['1.234', 'KWD', '1234'],
    ];
    for (const [input, cur, expected] of rows) expect(toMinor(input, cur), `${input} ${cur}`).toBe(expected);
  });

  it('round trips', () => {
    for (const [minor, cur] of [['95050', 'DKK'], ['5', 'AUD'], ['1500', 'JPY'], ['1234', 'KWD']] as const) expect(toMinor(fromMinor(minor, cur), cur)).toBe(minor);
  });
});
