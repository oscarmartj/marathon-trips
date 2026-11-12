import { describe, expect, it } from 'vitest';
import { bpsToPercent, dollarsToMinor, enAU, minorToDollars, nightsBetween, percentToBps, slugify, wholeNumber, withEnAU, withOptionalEnAU } from './catalogue-panel';

describe('localised text', () => {
  it('reads en-AU and keeps other languages when it changes', () => {
    expect(enAU({ 'en-AU': 'Hello', 'es-ES': 'Hola' })).toBe('Hello');
    expect(enAU({ 'es-ES': 'Hola' })).toBe('');
    expect(enAU(null)).toBe('');
    expect(withEnAU({ 'en-AU': 'Old', 'es-ES': 'Hola' }, '  New  ')).toEqual({ 'en-AU': 'New', 'es-ES': 'Hola' });
    expect(withEnAU(undefined, 'Only')).toEqual({ 'en-AU': 'Only' });
  });
  it('removes en-AU from an optional field when it is emptied', () => {
    expect(withOptionalEnAU({ 'en-AU': 'x', 'es-ES': 'y' }, ' ')).toEqual({ 'es-ES': 'y' });
  });
});

describe('money text (string operations, no floats)', () => {
  it.each([
    ['500', '50000'], ['500.5', '50050'], ['500.50', '50050'], ['0.99', '99'], ['0.05', '5'], ['0', '0'], ['1234567.89', '123456789'], ['  12  ', '1200'],
  ])('%s becomes %s minor units', (input, minor) => expect(dollarsToMinor(input)).toBe(minor));
  it.each(['', '-5', '5.', '.5', '1.234', '1,000', 'abc', '1e3', '12345678901'])('rejects %j', (input) => expect(dollarsToMinor(input)).toBeNull());
  it.each([['50000', '500.00'], ['50050', '500.50'], ['99', '0.99'], ['5', '0.05'], ['0', '0.00'], ['123456789', '1234567.89']])('shows %s as %s', (minor, text) => expect(minorToDollars(minor)).toBe(text));
  it('round-trips', () => {
    for (const minor of ['1', '10', '100', '12345', '99999999']) expect(dollarsToMinor(minorToDollars(minor))).toBe(minor);
  });
  it('turns a percentage into basis points and back', () => {
    expect(percentToBps('25')).toBe(2500);
    expect(percentToBps('25.5')).toBe(2550);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('100')).toBe(10000);
    for (const bad of ['0', '100.01', '101', '-1', '5.', 'x', '1.234']) expect(percentToBps(bad)).toBeNull();
    expect(bpsToPercent(2500)).toBe('25');
    expect(bpsToPercent(2550)).toBe('25.5');
    expect(bpsToPercent(2505)).toBe('25.05');
    expect(bpsToPercent(1)).toBe('0.01');
  });
});

describe('small helpers', () => {
  it('counts nights between calendar dates across a month and a leap day', () => {
    expect(nightsBetween('2027-06-18', '2027-06-21')).toBe(3);
    expect(nightsBetween('2028-02-27', '2028-03-01')).toBe(3);
  });
  it('reads whole numbers only', () => {
    expect(wholeNumber(' 12 ')).toBe(12);
    expect(wholeNumber('1.5')).toBeUndefined();
    expect(wholeNumber('')).toBeUndefined();
  });
  it('makes slugs the API accepts', () => {
    expect(slugify('Gold Coast Marathon 2027!')).toBe('gold-coast-marathon-2027');
    expect(slugify('  Ñandú -- Run  ')).toBe('nandu-run');
  });
});
