import { describe, expect, it } from 'vitest';
import { brand, brandCssVariables } from './brand.config';
import { contrastRatio } from './contrast';

describe('brand colours', () => {
  it('computes known contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it.each(brand.contrastPairs)('%s on %s meets 4.5:1 (WCAG 2.2 AA text)', (fg, bg) => {
    expect(contrastRatio(brand.colours[fg], brand.colours[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(brand.nonTextPairs)('%s against %s meets 3:1 (WCAG 2.2 AA non-text)', (fg, bg) => {
    expect(contrastRatio(brand.colours[fg], brand.colours[bg])).toBeGreaterThanOrEqual(3);
  });

  it('every colour is a six-digit hex value', () => {
    for (const v of Object.values(brand.colours)) expect(v).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('emits one custom property per colour plus the fonts', () => {
    const css = brandCssVariables();
    for (const k of Object.keys(brand.colours)) {
      expect(css).toContain(`--color-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:`);
    }
    expect(css).toContain('--font-display:');
  });
});
