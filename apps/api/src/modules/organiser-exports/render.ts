import { guardCell } from '../../platform/common/csv';
import type { ExportIssue } from '@mt/shared';
import type { ColumnDef, FormatDefinition } from './formats';
import { SOURCES, writeValue, type Runner } from './sources';

/** One cell of one runner, as text. The only way a runner's data reaches a file. */
export const cellOf = (c: ColumnDef, r: Runner): string => writeValue(SOURCES[c.source], r, c.as);

/** Problems of one runner for this format: a required column without a value, a value longer than the column allows. */
export function problemsOf(format: FormatDefinition, r: Runner): ExportIssue['problems'] {
  const out: ExportIssue['problems'] = [];
  for (const c of format.columns) {
    const v = cellOf(c, r);
    if (v === '' && c.required) out.push({ column: c.header, code: 'missing' });
    else if (c.maxLength !== undefined && [...v].length > c.maxLength) out.push({ column: c.header, code: 'too_long' });
  }
  return out;
}

// Leading whitespace of a fragment, except tab and CR: those are formula characters themselves, so the guard sees them.
const LEADING_SPACE = /^[^\S\t\r]*/;

/**
 * The platform formula guard (a leading =, +, -, @, tab or CR, after any quotes, gets a quote in front), on every
 * fragment of the cell split on a comma or a semicolon and after the fragment's leading whitespace: an organiser may
 * open a comma file with semicolons (or the reverse), and then each fragment becomes a cell of its own, trimmed. The
 * first fragment is the start of the cell, so a leading formula character is guarded as before.
 */
export function guardFragments(text: string): string {
  return text
    .split(/([,;])/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      const space = LEADING_SPACE.exec(part)![0];
      return space + guardCell(part.slice(space.length));
    })
    .join('');
}

/** Quoted when it holds a quote, a comma, a semicolon, CR or LF, whatever the format's delimiter. */
function quote(s: string): string {
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The file. Built by walking the format's columns: a runner is only ever asked for the sources the format names, and
 * every cell is text that goes through the formula guard on each comma or semicolon fragment (a leading =, +, -, @, tab or
 * CR gets a quote in front) and is quoted when it holds either separator.
 * UTF-8; a byte order mark only when the format says the organiser needs it.
 */
export function renderCsv(format: FormatDefinition, runners: readonly Runner[]): string {
  const { delimiter, bom, eol } = format.file;
  const lines = [format.columns.map((c) => quote(c.header)).join(delimiter)];
  for (const r of runners) lines.push(format.columns.map((c) => quote(guardFragments(cellOf(c, r)))).join(delimiter));
  return `${bom ? '﻿' : ''}${lines.join(eol)}${eol}`;
}

/** A file name from slugs only: race slug, year, format id, day. Never a name or free text. */
export function safeFilename(raceSlug: string, year: number, formatId: string, day: string): string {
  const part = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
  return `${part(raceSlug)}-${year}-${part(formatId)}-${day.replace(/-/g, '')}.csv`;
}
