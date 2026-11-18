// The platform CSV writer (task 7.fix-5): a comma file must stay safe when a spreadsheet opens it with `;` as the
// separator (European Excel, LibreOffice), and the other way round for a comma fragment of a cell. Every fragment of a
// text cell split on `,` or `;` gets the formula guard, a cell holding `;` is quoted, and the import reads back the text.
import { describe, expect, it } from 'vitest';
import { cell, guardCell, parseCsv, toCsv, unguardCell } from '../../src/platform/common/csv';

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * How a spreadsheet reads a CSV with a given separator: a quote opens a quoted field only at the start of a field, `""`
 * inside it is a quote, and text after the closing quote is kept. Fields are trimmed of spaces, the way a reader with
 * "trim spaces" on sees them.
 */
function readAs(text: string, delimiter: ',' | ';'): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let atStart = true;
  const end = () => {
    row.push(field.replace(/^ +| +$/g, ''));
    field = '';
    atStart = true;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inQuotes) {
      if (ch === '"' && body[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') inQuotes = false;
      else field += ch;
      continue;
    }
    if (ch === '"' && atStart) { inQuotes = true; atStart = false; continue; }
    if (ch === delimiter) { end(); continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      end();
      rows.push(row);
      row = [];
      continue;
    }
    field += ch;
    if (ch !== ' ') atStart = false;
  }
  if (field !== '' || row.length) { end(); rows.push(row); }
  return rows;
}

const HYPERLINK = '=HYPERLINK("http://evil.test","x")';

describe('formula guard on every comma and semicolon fragment (table)', () => {
  it.each([
    // [text, the cell as written]
    [`Marathon;${HYPERLINK}`, `"Marathon;'=HYPERLINK(""http://evil.test"",""x"")"`],
    [`Marathon,${HYPERLINK}`, `"Marathon,'=HYPERLINK(""http://evil.test"",""x"")"`],
    ['Smith; =1+1', `"Smith; '=1+1"`],
    ['Smith,   +SUM(A1)', `"Smith,   '+SUM(A1)"`],
    ['a;-1;@ref', `"a;'-1;'@ref"`],
    ['a;\t=1', `"a;'\t=1"`],
    ['a;\r=1', `"a;'\r=1"`],
    ['a;\n=1', `"a;\n'=1"`],
    ["a;'=b", `"a;''=b"`],
    ['  =lead', "  '=lead"],
    [HYPERLINK, `"'=HYPERLINK(""http://evil.test"",""x"")"`],
    ['10 km - fun run; 5 km - walk', '"10 km - fun run; 5 km - walk"'],
    ['1=1;a-b', '"1=1;a-b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line1\r\nline2', '"line1\r\nline2"'],
    ['plain text', 'plain text'],
    ['Óscar — ñandú', 'Óscar — ñandú'],
    ['', ''],
  ])('%j', (text, written) => {
    expect(cell(text)).toBe(written);
    expect(unguardCell(guardCell(text))).toBe(text);
  });

  it('numbers, booleans and dates are not text and are not guarded', () => {
    expect(cell(-5)).toBe('-5');
    expect(cell(true)).toBe('true');
    expect(cell(new Date('2027-06-19T00:00:00.000Z'))).toBe('2027-06-19T00:00:00.000Z');
  });

  it('a header holding a semicolon is quoted', () => {
    expect(toCsv(['a;b', 'c'], []).replace('﻿', '')).toBe('"a;b",c\r\n');
  });
});

describe('a whole file, read with either separator and read back by the import', () => {
  const rows = [
    [`Marathon;${HYPERLINK}`, 'Harbour Hotel, -2 rooms', 'Smith; +61 400 000 000', 'a;\t=1', 'say "x"; =y', 'línea\nnueva;@z', '=cmd|\' /C calc\'!A0', 'plain'],
    ['Coach; -  10 km', "already;'=guarded", ' ; ; =', 'x,y;z', '', '10 km - fun run', 'a, b', '@'],
  ];
  const header = ['transfer', 'hotel', 'phone', 'tab', 'quote', 'newline', 'cmd', 'plain'];
  const text = toCsv(header, rows);

  it.each([[','], [';']] as const)('no field read with %j starts like a formula', (delimiter) => {
    const fields = readAs(text, delimiter).flat();
    expect(fields.length).toBeGreaterThan(header.length);
    for (const f of fields) expect(FORMULA_START.test(f), JSON.stringify(f)).toBe(false);
  });

  it('the comma reader sees one field per column, and the import reads back every text exactly', () => {
    expect(readAs(text, ',').map((r) => r.length)).toEqual([header.length, header.length, header.length]);
    const parsed = parseCsv(text);
    expect(parsed[0]).toEqual(header);
    expect(parsed.slice(1).map((r) => r.map(unguardCell))).toEqual(rows);
  });

  it('unguard reverses a guard only where the guard would have put one', () => {
    for (const s of ["it's", "a;'b", "x,'", "'", "a; 'plain"]) {
      expect(guardCell(s)).toBe(s);
      expect(unguardCell(s)).toBe(s);
    }
  });
});
