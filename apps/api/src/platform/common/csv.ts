// CSV for the table capabilities (task 0.5): RFC 4180 quoting, formula guard on text cells (on every comma and semicolon
// fragment since 7.fix-5), and a small parser.

// Text that starts with a formula character, or with quotes and then one (so a guarded cell and a value that already looks
// guarded both survive an export and an import).
const FORMULA = /^'*[=+\-@\t\r]/;
const GUARDED = /^'+[=+\-@\t\r]/;
// Leading whitespace of a fragment, except tab and CR: those are formula characters themselves, so the guard sees them.
const LEADING_SPACE = /^[^\S\t\r]*/;

/**
 * Runs `each` on every fragment of the text split on a comma or a semicolon, after the fragment's leading whitespace.
 * A spreadsheet may open a comma file with semicolons (European Excel, LibreOffice) or the reverse, and then each fragment
 * becomes a cell of its own, often trimmed. The first fragment is the start of the cell. The guard only ever inserts a
 * quote, never a separator or whitespace, so the export and the import split a cell in the same places (7.fix-5).
 */
function eachFragment(text: string, each: (fragment: string) => string): string {
  return text
    .split(/([,;])/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const space = LEADING_SPACE.exec(part)![0];
      return space + each(part.slice(space.length));
    })
    .join('');
}

/**
 * A text cell that a spreadsheet could run as a formula gets a leading quote, on every comma or semicolon fragment (a
 * fragment starting with =, +, -, @, tab or CR, after its leading spaces and any quotes); the import takes it off again.
 */
export function guardCell(text: string): string {
  return eachFragment(text, (f) => (FORMULA.test(f) ? `'${f}` : f));
}

export function unguardCell(text: string): string {
  return eachFragment(text, (f) => (GUARDED.test(f) ? f.slice(1) : f));
}

/** Quoted when it holds a quote, a comma, a semicolon, CR or LF, so a reader splitting on either separator keeps it whole. */
function quote(s: string): string {
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type CsvValue = string | number | boolean | Date | null | undefined;

/**
 * A finite number as plain decimal text, never with an exponent ("1e-7" becomes "0.0000001"), so a spreadsheet and the
 * import read back exactly the number that was stored. JavaScript prints the shortest text that reads back to the same
 * double, and this only moves the decimal point of that text.
 */
export function plainDecimal(n: number): string {
  const text = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text === '-0' ? '0' : text;
  const [, sign, whole, frac = '', exp] = m as unknown as [string, string, string, string | undefined, string];
  const digits = whole + frac;
  const point = whole.length + Number(exp);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Numbers (as plain decimals), booleans and dates are written as they are (a negative number is not a formula); text is guarded. */
export function cell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return plainDecimal(v);
  if (typeof v === 'boolean') return String(v);
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
