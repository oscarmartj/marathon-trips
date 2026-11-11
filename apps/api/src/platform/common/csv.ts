// CSV for the table capabilities (task 0.5): RFC 4180 quoting, formula guard on text cells, and a small parser.

const FORMULA = /^[=+\-@\t\r]/;

/** A text cell that a spreadsheet could run as a formula gets a leading quote; the import takes it off again. */
export function guardCell(text: string): string {
  return FORMULA.test(text) ? `'${text}` : text;
}

export function unguardCell(text: string): string {
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

function quote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type CsvValue = string | number | boolean | Date | null | undefined;

/** Numbers, booleans and dates are written as they are (a negative number is not a formula); text is guarded. */
export function cell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return quote(guardCell(v));
}

export function toCsv(header: readonly string[], rows: readonly CsvValue[][]): string {
  const lines = [header.map((h) => quote(h)).join(','), ...rows.map((r) => r.map(cell).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export class CsvParseError extends Error {
  constructor(public readonly code: 'bad_csv' | 'empty_file') {
    super(code);
  }
}

/** Parses RFC 4180 text into rows of cells. Throws `bad_csv` for an unterminated quote or a stray quote. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
    quoted = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row); // blank lines are skipped
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (field !== '' || quoted) throw new CsvParseError('bad_csv');
      inQuotes = true;
      quoted = true;
      i++;
    } else if (ch === ',') {
      endField();
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      if (quoted) throw new CsvParseError('bad_csv');
      field += ch;
      i++;
    }
  }
  if (inQuotes) throw new CsvParseError('bad_csv');
  if (field !== '' || row.length > 0 || quoted) endRow();
  if (rows.length === 0) throw new CsvParseError('empty_file');
  return rows;
}
