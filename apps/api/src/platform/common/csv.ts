// CSV for the table capabilities (task 0.5): RFC 4180 quoting, formula guard on text cells (on every comma, semicolon
// and line-break fragment since 7.fix-5), and a small parser.

// From a fragment start: quotes and spaces, then a formula character. Quotes of either kind count, because a reader that
// splits on the other separator sees a fragment `"=1` or `"" =1` as a quoted field and drops the quotes. GUARDED is the
// same with the guard quote in front, so a guarded cell and a value that already looks guarded both survive an export and
// an import, and unguard(guard(x)) is x for every x.
const FORMULA = /(?:['"]|[^\S\t\r\n])*[=+\-@\t\r]/y;
const GUARDED = /'(?:['"]|[^\S\t\r\n])*[=+\-@\t\r]/y;
// What a spreadsheet may start a new cell after: either separator (it may open a comma file with semicolons, or the
// reverse) and a line break (a reader that splits on the other separator does not see our quotes, so CR or LF ends the row).
const SEPARATOR = /[,;\r\n]/;
// Leading whitespace of a fragment, except tab, CR and LF: tab and CR are formula characters, CR and LF separators.
const SPACE = /[^\S\t\r\n]/;

/**
 * Where a fragment starts: the start of the text and the character after each comma, semicolon, CR or LF, each after its
 * leading spaces (readers often trim them). A guard quote is neither a separator nor a space, so a guarded text has its
 * fragment starts at the same characters as the original (7.fix-5).
 */
function fragmentStarts(text: string): number[] {
  const out: number[] = [];
  let p = 0;
  for (;;) {
    while (p < text.length && SPACE.test(text[p]!)) p++;
    out.push(p);
    let k = p;
    while (k < text.length && !SEPARATOR.test(text[k]!)) k++;
    if (k >= text.length) return out;
    p = k + 1;
  }
}

const matchesAt = (re: RegExp, text: string, p: number): boolean => {
  re.lastIndex = p;
  return re.test(text);
};

/**
 * A text cell that a spreadsheet could run as a formula gets a quote in front of every fragment (split on a comma, a
 * semicolon, CR or LF) that starts, after spaces and any quotes, with =, +, -, @, tab or CR. The import takes it off again.
 */
export function guardCell(text: string): string {
  let out = '';
  let from = 0;
  for (const p of fragmentStarts(text)) {
    if (!matchesAt(FORMULA, text, p)) continue;
    out += `${text.slice(from, p)}'`;
    from = p;
  }
  return out + text.slice(from);
}

export function unguardCell(text: string): string {
  let out = '';
  let from = 0;
  for (const p of fragmentStarts(text)) {
    if (!matchesAt(GUARDED, text, p)) continue;
    out += text.slice(from, p);
    from = p + 1;
  }
  return out + text.slice(from);
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
