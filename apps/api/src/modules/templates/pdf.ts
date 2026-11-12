// A small PDF writer for plain-text documents (task 5.4). No dependency: a confirmation, voucher or receipt is a title
// and wrapped paragraphs on A4, set in the standard Helvetica fonts that every PDF reader has built in, so no font is
// embedded. Text is encoded as WinAnsi; a character outside it prints as "?". Nothing here reads files or the network.

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const BODY_SIZE = 11;
const TITLE_SIZE = 18;
const LEADING = 15;
const MAX_PAGES = 50;

/** Helvetica advance widths (1/1000 em) for the printable ASCII range 32..126. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Unicode characters outside Latin-1 that WinAnsi does have, with their byte. */
const WIN_ANSI: Record<string, number> = { '€': 0x80, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '…': 0x85 };

function toWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const mapped = WIN_ANSI[ch];
    const code = ch.codePointAt(0)!;
    if (mapped !== undefined) out.push(mapped);
    else if (code === 0x09) out.push(0x20);
    else if (code >= 0x20 && code <= 0x7e) out.push(code);
    else if (code >= 0xa0 && code <= 0xff) out.push(code);
    else if (code >= 0x80 || code < 0x20) out.push(0x3f);
  }
  return out;
}

const widthOf = (byte: number): number => (byte >= 32 && byte <= 126 ? HELVETICA[byte - 32]! : 556);
const measure = (bytes: number[], size: number, scale = 1): number => (bytes.reduce((n, b) => n + widthOf(b), 0) * size * scale) / 1000;

/** Greedy word wrap. A word wider than the line is broken where it overflows. */
function wrap(line: string, maxWidth: number, size: number, scale = 1): number[][] {
  const words = toWinAnsi(line).reduce<number[][]>(
    (acc, b) => {
      if (b === 0x20) acc.push([]);
      else acc[acc.length - 1]!.push(b);
      return acc;
    },
    [[]],
  );
  const lines: number[][] = [];
  let cur: number[] = [];
  const space = [0x20];
  for (const w of words) {
    if (w.length === 0) continue;
    let word = w;
    while (measure(word, size, scale) > maxWidth) {
      let cut = word.length - 1;
      while (cut > 1 && measure(word.slice(0, cut), size, scale) > maxWidth) cut--;
      if (cur.length) lines.push(cur);
      lines.push(word.slice(0, cut));
      cur = [];
      word = word.slice(cut);
    }
    const next = cur.length ? [...cur, ...space, ...word] : word;
    if (cur.length && measure(next, size, scale) > maxWidth) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur.length || lines.length === 0) lines.push(cur);
  return lines;
}

const escapeBytes = (bytes: number[]): string => bytes.map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : String.fromCharCode(b))).join('');

export interface PdfInput {
  title: string;
  /** Plain text. A line break starts a new line and a blank line starts a new paragraph. */
  body: string;
}

/** Builds the PDF. Throws if the text needs more than 50 pages: a template is a page or two, not a book. */
export function buildPdf({ title, body }: PdfInput): Buffer {
  const width = PAGE_W - MARGIN * 2;
  type Row = { bytes: number[]; size: number; bold: boolean; gap: number };
  const rows: Row[] = [];
  const titleLines = title.trim() ? wrap(title.replace(/\s+/g, ' '), width, TITLE_SIZE, 1.1) : [];
  titleLines.forEach((bytes, i) => rows.push({ bytes, size: TITLE_SIZE, bold: true, gap: i === titleLines.length - 1 ? LEADING : 0 }));
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') rows.push({ bytes: [], size: BODY_SIZE, bold: false, gap: 0 });
    else for (const bytes of wrap(raw, width, BODY_SIZE)) rows.push({ bytes, size: BODY_SIZE, bold: false, gap: 0 });
  }

  const pages: string[] = [];
  let y = PAGE_H - MARGIN;
  let ops: string[] = [];
  const flush = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = PAGE_H - MARGIN;
  };
  for (const r of rows) {
    const step = r.size === TITLE_SIZE ? r.size + 4 : LEADING;
    if (y - step < MARGIN) flush();
    y -= step;
    if (r.bytes.length) ops.push(`BT /${r.bold ? 'F2' : 'F1'} ${r.size} Tf ${MARGIN} ${y.toFixed(2)} Td (${escapeBytes(r.bytes)}) Tj ET`);
    y -= r.gap;
    if (pages.length >= MAX_PAGES) throw new Error('document_too_long');
  }
  flush();

  // Objects: 1 catalog, 2 pages, 3 regular font, 4 bold font, 5 info, then a page and its content stream per page.
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ');
  const objects: Array<string | Buffer> = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Producer (Marathon Trips) /Title (${escapeBytes(toWinAnsi(title))}) >>`,
  ];
  pages.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + i * 2} 0 R >>`);
    const stream = Buffer.from(content, 'latin1');
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]));
  });

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objects.forEach((o, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof o === 'string' ? Buffer.from(o, 'latin1') : o, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
  parts.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
