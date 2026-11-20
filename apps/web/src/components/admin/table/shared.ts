import { t } from '@/lib/i18n-admin';
import { errorMessage } from '../step-up';

export interface ColumnMeta {
  key: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'enum';
  sortable: boolean;
  filterable: boolean;
  searchable: boolean;
  exportable: boolean;
  ops: string[];
  values: string[] | null;
}

export interface Meta {
  entityType: string;
  columns: ColumnMeta[];
  softDelete: boolean;
  taggable: boolean;
  notes: boolean;
  bulkActions: string[];
  importColumns: string[];
  can: { write: boolean; delete: boolean; export: boolean; import: boolean; annotate: boolean };
}

export interface TagView {
  id: string;
  name: string;
  colour: string;
}

export type TableRow = { id: string; version?: number; deletedAt?: string | null; tags?: TagView[] } & Record<string, unknown>;

export interface Filter {
  field: string;
  op: string;
  value?: string | number | boolean | Array<string | number>;
}

export interface QueryState {
  q: string;
  filters: Filter[];
  sort: Array<{ field: string; dir: 'asc' | 'desc' }>;
  tagIds: string[];
  tagMode: 'any' | 'all';
  deleted: 'exclude' | 'include' | 'only';
}

export const emptyQuery: QueryState = { q: '', filters: [], sort: [], tagIds: [], tagMode: 'any', deleted: 'exclude' };

/** The query as the API's JSON body (saved views, export). */
export const queryBody = (q: QueryState) => ({ ...q, q: q.q.trim() === '' ? undefined : q.q.trim() });

export function queryParams(q: QueryState, page: number, pageSize: number): string {
  const p = new URLSearchParams();
  if (q.q.trim()) p.set('q', q.q.trim());
  if (q.filters.length) p.set('filters', JSON.stringify(q.filters));
  if (q.sort.length) p.set('sort', q.sort.map((s) => `${s.field}:${s.dir}`).join(','));
  if (q.tagIds.length) p.set('tags', q.tagIds.join(','));
  p.set('tagMode', q.tagMode);
  p.set('deleted', q.deleted);
  p.set('page', String(page));
  p.set('pageSize', String(pageSize));
  return p.toString();
}

/** A message for an API error: the specific one when the catalogue has it, else the general one. */
export function errText(r: { status: number; body: { code?: string } }): string {
  const code = r.body?.code;
  if (code) {
    try {
      return t(`admin.table.errors.${code}`);
    } catch {
      /* falls through to the general message */
    }
  }
  return errorMessage(r);
}

/** Catalogue lookup that falls back to the raw text (enum values the page did not translate). */
export function maybe(key: string, fallback: string): string {
  try {
    return t(key);
  } catch {
    return fallback;
  }
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
}
