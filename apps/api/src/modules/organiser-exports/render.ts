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

function quote(s: string, delimiter: string): string {
  return s.includes('"') || s.includes(delimiter) || s.includes('\r') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The file. Built by walking the format's columns: a runner is only ever asked for the sources the format names, and
 * every cell is text that goes through the formula guard (a leading =, +, -, @, tab or CR gets a quote in front).
 * UTF-8; a byte order mark only when the format says the organiser needs it.
 */
export function renderCsv(format: FormatDefinition, runners: readonly Runner[]): string {
  const { delimiter, bom, eol } = format.file;
  const lines = [format.columns.map((c) => quote(c.header, delimiter)).join(delimiter)];
  for (const r of runners) lines.push(format.columns.map((c) => quote(guardCell(cellOf(c, r)), delimiter)).join(delimiter));
  return `${bom ? '﻿' : ''}${lines.join(eol)}${eol}`;
}

/** A file name from slugs only: race slug, year, format id, day. Never a name or free text. */
export function safeFilename(raceSlug: string, year: number, formatId: string, day: string): string {
  const part = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
  return `${part(raceSlug)}-${year}-${part(formatId)}-${day.replace(/-/g, '')}.csv`;
}
