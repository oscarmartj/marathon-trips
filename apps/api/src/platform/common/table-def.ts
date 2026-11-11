import type { ColumnType } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { AuditActor } from '../audit/audit.service';

export type Row = Record<string, unknown>;
export type Actor = AuditActor & { id: string };

export interface TableColumn {
  /** Name of the Prisma field. Requests only ever name keys from this whitelist. */
  key: string;
  type: ColumnType;
  sortable?: boolean;
  filterable?: boolean;
  /** Matched by the `q` box (case-insensitive contains). Text columns only. */
  searchable?: boolean;
  exportable?: boolean;
  nullable?: boolean;
  /** Allowed values of an `enum` column. */
  values?: readonly string[];
}

export interface BulkAction {
  key: string;
  /** The permission this row needs for this action; the single-record route calls the same function (plan 0.5). */
  permissionFor(row: Row): string | readonly string[];
  /** Runs inside the element's own transaction. Throws an ApiError or AppError whose code becomes the result. */
  run(tx: Prisma.TransactionClient, actor: Actor, row: Row, reason?: string): Promise<void>;
}

export interface CsvIssue {
  column: string;
  code: string;
}

export interface ImportSpec {
  /** Columns a file may carry and write. */
  columns: readonly string[];
  /** Columns in an export that an import reads but ignores, so a file the table exported can be imported again. */
  ignored: readonly string[];
  required: readonly string[];
  /** Validates one row of text cells. Returns the parsed value or the issues; never a cell value. */
  parseRow(cells: Record<string, string>): { value?: unknown; issues: CsvIssue[] };
  /** Writes every row in the caller's transaction. */
  insert(tx: Prisma.TransactionClient, actor: Actor, values: unknown[], csvJobId: string): Promise<void>;
}

/** What a table declares once to get search, filters, views, bulk actions, CSV, tags, notes, history and soft delete. */
export interface TableDef {
  entityType: string;
  /** Prisma model name. */
  model: string;
  permissions: { read: string; write: string; delete?: string; export?: string; import?: string; annotate?: string };
  columns: readonly TableColumn[];
  softDelete: boolean;
  /** Has a `version` column (optimistic lock). */
  versioned: boolean;
  taggable: boolean;
  notes: boolean;
  /** Show @pii before and after values in the record's history to staff who can read the table. Default off. */
  historyShowsPii?: boolean;
  /** Title and subtitle for the global search index, or null to keep the record out of it. */
  searchDocument?(row: Row): { title: string; subtitle?: string | null } | null;
  bulkActions?: readonly BulkAction[];
  import?: ImportSpec;
}

type Delegate = {
  findMany(args: unknown): Promise<Row[]>;
  findUnique(args: unknown): Promise<Row | null>;
  count(args: unknown): Promise<number>;
  update(args: unknown): Promise<Row>;
  updateMany(args: unknown): Promise<{ count: number }>;
};

export function delegateOf(tx: Prisma.TransactionClient | object, def: TableDef): Delegate {
  const name = def.model.charAt(0).toLowerCase() + def.model.slice(1);
  return (tx as Record<string, Delegate>)[name]!;
}

/** `Task` becomes `task`, `SavedView` becomes `saved_view`: the entity part of an audit action or event type. */
export const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
