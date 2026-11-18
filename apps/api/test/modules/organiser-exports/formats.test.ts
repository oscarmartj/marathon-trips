// Organiser exports (task 7.2, plan docs/plans/7.2-organiser-exports.md, section 3): the parts that need no database.
// The whitelist is structural: a file is built by walking the format's columns, so nothing else can be written.
import { describe, expect, it } from 'vitest';
import { FORMATS, SOURCE_KEYS, SOURCES, defineFormat, formatsForRace, problemsOf, renderCsv, safeFilename } from '../../../src/modules/organiser-exports';
import type { FormatDefinition, Runner } from '../../../src/modules/organiser-exports';

const ana: Runner = {
  givenName: 'Ana', familyName: 'García-López', dateOfBirth: '1988-03-14', estimatedFinishSeconds: 14_461,
  emergencyContactName: "Sean O'Neil", emergencyContactPhone: '+61 400 123 456', distanceName: 'Marathon', distanceMetres: 42_195, countryOfResidence: 'AU',
};
const basic = FORMATS.find((f) => f.id === 'entry_list_basic')!;
const intl = FORMATS.find((f) => f.id === 'entry_list_international')!;
const lines = (csv: string, eol = '\r\n') => csv.replace(/^\uFEFF/, '').split(eol).filter(Boolean);

const base: FormatDefinition = { id: 'test_format', label: 'T', organiser: 'T', appliesTo: {}, participation: ['runner_with_entry'], file: { delimiter: ',', bom: false, eol: '\r\n' }, columns: [{ header: 'Name', source: 'givenName', required: true }] };

describe('whitelist_enforced_structurally', () => {
  it('the header is exactly the format headers and a row has exactly one cell per column', () => {
    const rows = lines(renderCsv(basic, [ana]));
    expect(rows[0]).toBe('Given name,Family name,Date of birth,Distance');
    expect(rows[1]).toBe('Ana,García-López,1988-03-14,Marathon');
  });

  it('a runner record with extra fields (passport, email, price, notes) renders exactly the same file', () => {
    const extended = { ...ana, passportNumber: 'X1234567', email: 'ana@example.test', priceMinor: 999_900, notes: 'asthmatic', customerPhone: '+61 411 111 111' } as Runner;
    for (const f of FORMATS) expect(renderCsv(f, [extended])).toBe(renderCsv(f, [ana]));
    const out = renderCsv(intl, [extended]);
    for (const secret of ['X1234567', 'ana@example.test', '999900', 'asthmatic', '411 111 111']) expect(out).not.toContain(secret);
  });

  it('a format that does not name emergency contact or finish time never writes them', () => {
    const out = renderCsv(basic, [ana]);
    for (const hidden of ['Sean', '400 123', '04:01:01', 'Australia', '14461']) expect(out).not.toContain(hidden);
  });

  it('the sources are a closed list with nothing about email, customer phone, passport, price, status or notes', () => {
    expect([...SOURCE_KEYS].sort()).toEqual(['countryOfResidence', 'dateOfBirth', 'distance', 'emergencyContactName', 'emergencyContactPhone', 'estimatedFinishTime', 'familyName', 'givenName']);
    expect(SOURCE_KEYS.filter((k) => /email|passport|price|total|status|note|payment|customer|gender|nationality/i.test(k))).toEqual([]);
  });

  it('defineFormat rejects a source that is not in the list, and the other bad definitions', () => {
    const bad = (over: Partial<FormatDefinition>) => () => defineFormat({ ...base, ...over });
    expect(bad({ columns: [{ header: 'P', source: 'passportNumber' as never, required: false }] })).toThrow(/unknown source/);
    expect(bad({ columns: [{ header: 'P', source: 'toString' as never, required: false }] })).toThrow(/unknown source/);
    expect(bad({ columns: [] })).toThrow(/no columns/);
    expect(bad({ columns: [{ header: 'A', source: 'givenName', required: true }, { header: 'A', source: 'familyName', required: true }] })).toThrow(/twice/);
    expect(bad({ columns: [{ header: 'A', source: 'givenName', required: true, as: 'dmy' }] })).toThrow(/not a way to write/);
    expect(bad({ columns: [{ header: ' ', source: 'givenName', required: true }] })).toThrow(/empty/);
    for (const h of ['=A', '+A', '-A', '@A', ' =A']) expect(bad({ columns: [{ header: h, source: 'givenName', required: true }] })).toThrow(/formula/);
    expect(bad({ columns: [{ header: 'A\nB', source: 'givenName', required: true }] })).toThrow(/control/);
    expect(bad({ participation: ['supporter' as never] })).toThrow(/not a runner type/);
    expect(bad({ participation: [] })).toThrow(/participation/);
    expect(bad({ file: { delimiter: '\t' as never, bom: false, eol: '\n' } })).toThrow(/delimiter/);
    expect(bad({ id: 'Bad Id' })).toThrow(/slug/);
    expect(() => defineFormat(base)).not.toThrow();
  });

  it('a defined format is frozen: a column cannot be added or a source changed afterwards', () => {
    const f = defineFormat(base);
    expect(() => (f.columns as unknown as unknown[]).push({ header: 'X', source: 'dateOfBirth', required: false })).toThrow();
    expect(() => { (f.columns[0] as { source: string }).source = 'dateOfBirth'; }).toThrow();
    expect(Object.isFrozen(f.file)).toBe(true);
    expect(Object.isFrozen(FORMATS)).toBe(true);
    expect(() => (FORMATS as unknown as unknown[]).push(base)).toThrow();
    expect(Object.isFrozen(SOURCES)).toBe(true);
    expect(Object.values(SOURCES).every((d) => Object.isFrozen(d))).toBe(true);
    expect(() => { (SOURCES as Record<string, unknown>).passport = { type: 'text', needs: 'name', raw: () => 'x' }; }).toThrow();
    for (const shipped of FORMATS) expect(Object.isFrozen(shipped.columns)).toBe(true);
  });

  it('every shipped format only names real sources and runner types', () => {
    for (const f of FORMATS) {
      for (const c of f.columns) expect(Object.keys(SOURCES)).toContain(c.source);
      expect(f.participation.every((p) => p === 'runner_with_entry' || p === 'runner_own_entry')).toBe(true);
    }
  });

  it('a format restricted to one race is offered for that race only', () => {
    const one = defineFormat({ ...base, id: 'only_sydney', appliesTo: { raceSlugs: ['sydney-marathon'] } });
    expect(formatsForRace('sydney-marathon', [one]).map((f) => f.id)).toEqual(['only_sydney']);
    expect(formatsForRace('gold-coast-marathon', [one])).toEqual([]);
    expect(formatsForRace('gold-coast-marathon', FORMATS).length).toBe(FORMATS.length);
  });
});

describe('formula_injection_neutralised', () => {
  const evil = ['=1+1', '+61 400 000 000', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd', "'=1+1", '=HYPERLINK("http://evil.test","x")'];
  it.each(evil)('a name of %j comes out with a quote in front', (value) => {
    const csv = renderCsv(base, [{ ...ana, givenName: value }]);
    const cell = csv.split('\r\n')[1]!;
    const unquoted = cell.startsWith('"') ? cell.slice(1) : cell;
    expect(/^[=+\-@\t\r]/.test(unquoted)).toBe(false);
    // leading whitespace is trimmed off a text value; anything that still starts like a formula is quoted
    if (/^[=+\-@']/.test(value.trim())) expect(unquoted.startsWith("'")).toBe(true);
  });
  it('also in a cell that has to be quoted (a comma or a newline) and in the other columns', () => {
    const csv = renderCsv(intl, [{ ...ana, givenName: '=A1,B1', emergencyContactName: '@x\ny', emergencyContactPhone: '+61 400' }]);
    expect(csv).toContain(";'=A1,B1;"); // a comma is not special when the delimiter is a semicolon
    expect(renderCsv(base, [{ ...ana, givenName: '=A1,B1' }])).toContain(`"'=A1,B1"`);
    expect(csv).toContain(`"'@x\ny"`);
    expect(csv).toContain(";'+61 400");
  });
  it('a normal name is untouched, and generated dates, durations and distances never start with a formula character', () => {
    expect(lines(renderCsv(base, [ana]))[1]).toBe('Ana');
    for (const row of lines(renderCsv(intl, [ana])).slice(1)) for (const cell of row.split(';')) expect(cell).not.toMatch(/^[=+\-@]/);
  });
});

describe('encoding_and_formats', () => {
  it('a byte order mark only when the format says so; delimiter and line ending per format', () => {
    expect(renderCsv(basic, [ana]).charCodeAt(0)).not.toBe(0xfeff);
    const out = renderCsv(intl, [ana]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.split('\r\n')[0]).toContain(';');
    const lf = defineFormat({ ...base, id: 'lf_format', file: { delimiter: ',', bom: false, eol: '\n' } });
    expect(renderCsv(lf, [ana, ana])).toBe('Name\nAna\nAna\n');
  });
  it('dates, durations, countries and distances are written the way each format asks', () => {
    expect(lines(renderCsv(intl, [ana]))[1]).toBe("García-López;Ana;14/03/1988;Australia;42.195;04:01:01;Sean O'Neil;'+61 400 123 456");
    const custom = defineFormat({
      ...base, id: 'custom_ways',
      columns: [
        { header: 'MDY', source: 'dateOfBirth', required: true, as: 'mdy' }, { header: 'ISO', source: 'dateOfBirth', required: true, as: 'iso' },
        { header: 'Mins', source: 'estimatedFinishTime', required: true, as: 'minutes' }, { header: 'CC', source: 'countryOfResidence', required: true, as: 'alpha2' },
        { header: 'Km', source: 'distance', required: true, as: 'km' },
      ],
    });
    expect(lines(renderCsv(custom, [ana, { ...ana, distanceMetres: 10_000 }]))).toEqual(['MDY,ISO,Mins,CC,Km', '03/14/1988,1988-03-14,241,AU,42.195', '03/14/1988,1988-03-14,241,AU,10']);
  });
  it('accents and apostrophes survive and a quote in a value is doubled', () => {
    const csv = renderCsv(base, [{ ...ana, givenName: 'Zoë "Zo" O\'Brien-Núñez' }]);
    expect(csv).toContain('"Zoë ""Zo"" O\'Brien-Núñez"');
  });
  it('a country that was erased (ZZ) or is not a code writes nothing', () => {
    const f = defineFormat({ ...base, id: 'country_only', columns: [{ header: 'C', source: 'countryOfResidence', required: false, as: 'name' }] });
    expect(lines(renderCsv(f, [{ ...ana, countryOfResidence: 'ZZ' }, { ...ana, countryOfResidence: 'xx' }, { ...ana, countryOfResidence: null }]))).toEqual(['C']);
  });
  it('the file name is built from slugs only and cannot break out', () => {
    expect(safeFilename('gold-coast-marathon', 2027, 'entry_list_basic', '2027-07-04')).toBe('gold-coast-marathon-2027-entry-list-basic-20270704.csv');
    const odd = safeFilename('../../etc/passwd"\r\nX: y', 2027, 'a b', '2027-07-04');
    expect(odd).toMatch(/^[a-z0-9-]+\.csv$/);
    expect(safeFilename('', 2027, '', '2027-07-04')).toMatch(/^[a-z0-9-]+\.csv$/);
  });
});

describe('validation', () => {
  it('lists missing required columns and too-long values by header, with codes only', () => {
    const none: Runner = { givenName: null, familyName: null, dateOfBirth: null, estimatedFinishSeconds: null, emergencyContactName: null, emergencyContactPhone: null, distanceName: null, distanceMetres: null, countryOfResidence: null };
    expect(problemsOf(basic, none).map((p) => `${p.column}:${p.code}`)).toEqual(['Given name:missing', 'Family name:missing', 'Date of birth:missing', 'Distance:missing']);
    expect(problemsOf(intl, { ...ana, emergencyContactName: null, estimatedFinishSeconds: null })).toEqual([]);
    expect(problemsOf(basic, { ...ana, givenName: 'x'.repeat(101) })).toEqual([{ column: 'Given name', code: 'too_long' }]);
    expect(problemsOf(basic, { ...ana, givenName: '   ' })).toEqual([{ column: 'Given name', code: 'missing' }]);
    expect(problemsOf(intl, { ...ana, countryOfResidence: 'ZZ' })).toEqual([{ column: 'Country', code: 'missing' }]);
    expect(JSON.stringify(problemsOf(basic, none))).not.toMatch(/Ana|García/);
  });
});
