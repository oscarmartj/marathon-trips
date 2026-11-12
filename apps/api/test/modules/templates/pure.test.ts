// The template language and the PDF writer (task 5.4): no database.
import { describe, expect, it } from 'vitest';
import { buildPdf } from '../../../src/modules/templates/pdf';
import { checkWording, fill, hasMalformedBraces, placeholdersOf } from '../../../src/modules/templates/render';
import { TEMPLATE_DEFINITIONS, sampleValues } from '../../../src/modules/templates/definitions';

describe('template_language', () => {
  it('finds placeholders, with or without spaces inside the braces, once each', () => {
    expect(placeholdersOf('Hi {{givenName}}, {{ reference }} and {{givenName}} again')).toEqual(['givenName', 'reference']);
  });

  it('fills every placeholder in one pass and never reads a value again', () => {
    expect(fill('Hi {{a}}, {{b}}.', { a: '{{b}}', b: 'there' })).toBe('Hi {{b}}, there.');
  });

  it('fails on a missing value instead of printing a blank', () => {
    expect(() => fill('Hi {{givenName}},', {})).toThrow(/givenName/);
  });

  it('keeps a subject on one line, whatever the values hold', () => {
    expect(fill('About {{x}}', { x: 'one\r\nBcc: someone@example.test' }, { singleLine: true })).toBe('About one Bcc: someone@example.test');
  });

  it('flags unknown variables and braces that are not placeholders', () => {
    expect(checkWording({ subject: 'Hi {{nope}}', body: 'Hello {{ first name }} {{reference}}' }, ['reference'])).toEqual([
      { field: 'subject', kind: 'unknown_variable', name: 'nope' },
      { field: 'body', kind: 'malformed' },
    ]);
    expect(hasMalformedBraces('open {{ only')).toBe(true);
    expect(hasMalformedBraces('fine {{reference}}')).toBe(false);
  });

  it('every starter wording uses only its own variables and renders with its sample data', () => {
    for (const d of TEMPLATE_DEFINITIONS) {
      expect(checkWording(d.starter, d.variables.map((v) => v.name)), d.key).toEqual([]);
      expect(() => fill(d.starter.body, sampleValues(d)), d.key).not.toThrow();
    }
  });
});

describe('pdf_writer', () => {
  const text = (b: Buffer) => b.toString('latin1');

  it('writes a valid single-page PDF whose cross-reference offsets point at the objects', () => {
    const pdf = buildPdf({ title: 'Booking confirmation', body: 'Hello (world) \\ back\n\nSecond paragraph.' });
    const s = text(pdf);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('(Booking confirmation) Tj');
    expect(s).toContain('(Hello \\(world\\) \\\\ back) Tj');
    const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(start, start + 4)).toBe('xref');
    const entries = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBe(Number(/\/Size (\d+)/.exec(s)![1]) - 1);
    entries.forEach((off, i) => expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it('wraps long lines and starts a new page when one is full', () => {
    const long = 'word '.repeat(2000);
    const pdf = text(buildPdf({ title: 'Long', body: long }));
    expect(Number(/\/Count (\d+)/.exec(pdf)![1])).toBeGreaterThan(1);
    expect(pdf).not.toMatch(/\(word( word){120,}\)/);
  });

  it('encodes Australian English punctuation and replaces what WinAnsi lacks', () => {
    const s = text(buildPdf({ title: 'T', body: 'A$2,450 – “quoted” café 日本' }));
    expect(s).toContain('\x96');
    expect(s).toContain('caf\xe9');
    expect(s).toContain('??');
  });

  it('refuses a document that would run past 50 pages', () => {
    expect(() => buildPdf({ title: 'T', body: 'line\n'.repeat(5000) })).toThrow('document_too_long');
  });
});
