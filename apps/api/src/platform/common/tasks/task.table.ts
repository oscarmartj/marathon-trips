import type { Prisma } from '../../../generated/prisma/client';
import { MAX_IMPORT_ROWS } from '@mt/shared';
import { COMMON_PERMISSIONS_KEYS as K } from '../permissions';
import type { BulkAction, CsvIssue, Row, TableDef } from '../table-def';
import type { TasksService } from './tasks.service';

const STATUSES = ['open', 'done', 'cancelled'] as const;
const SOURCES = ['manual', 'automation', 'system'] as const;

/** Manual tasks need the plain permission; tasks made by automation or the system need the special one as well. */
export const taskKeysFor = (row: Row, plain: string): string[] => (row.source === 'manual' ? [plain] : [plain, K.taskManageAutomated]);

export interface ImportedTask {
  title: string;
  description: string | null;
  dueAt: Date | null;
}

function parseDue(text: string): Date | null | 'invalid' {
  if (text === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return 'invalid';
  const d = new Date(text.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

/** The example table of phase 0: every shared capability, declared once. */
export function taskTable(tasks: TasksService): TableDef {
  const move = (key: string, to: (typeof STATUSES)[number]): BulkAction => ({
    key, permissionFor: (row) => taskKeysFor(row, K.taskWrite),
    run: async (tx, actor, row, reason) => void (await tasks.change(tx, actor, row.id as string, { status: to }, { reason })),
  });
  return {
    entityType: 'Task', model: 'Task',
    permissions: { read: K.taskRead, write: K.taskWrite, delete: K.taskDelete, export: K.taskExport, import: K.taskImport },
    softDelete: true, versioned: true, taggable: true, notes: true, historyShowsPii: true,
    columns: [
      { key: 'title', type: 'text', sortable: true, filterable: true, searchable: true, exportable: true },
      { key: 'description', type: 'text', filterable: true, searchable: true, exportable: true, nullable: true },
      { key: 'status', type: 'enum', values: STATUSES, sortable: true, filterable: true, exportable: true },
      { key: 'source', type: 'enum', values: SOURCES, sortable: true, filterable: true, exportable: true },
      { key: 'dueAt', type: 'date', sortable: true, filterable: true, exportable: true, nullable: true },
      { key: 'createdAt', type: 'date', sortable: true, filterable: true, exportable: true },
    ],
    searchDocument: (row) => ({ title: row.title as string, subtitle: row.status as string }),
    bulkActions: [
      move('complete', 'done'), move('cancel', 'cancelled'), move('reopen', 'open'),
      {
        key: 'delete', permissionFor: (row) => taskKeysFor(row, K.taskDelete),
        run: (tx, actor, row, reason) => tasks.setDeleted(tx, actor, row.id as string, true, reason),
      },
      {
        key: 'restore', permissionFor: (row) => taskKeysFor(row, K.taskDelete),
        run: (tx, actor, row, reason) => tasks.setDeleted(tx, actor, row.id as string, false, reason),
      },
    ],
    import: {
      columns: ['title', 'description', 'dueAt'],
      ignored: ['status', 'source', 'createdAt', 'tags'],
      required: ['title'],
      parseRow(cells): { value?: ImportedTask; issues: CsvIssue[] } {
        const issues: CsvIssue[] = [];
        const title = cells.title ?? '';
        if (title === '') issues.push({ column: 'title', code: 'required' });
        else if (title.length > 200) issues.push({ column: 'title', code: 'too_long' });
        const description = cells.description ?? '';
        if (description.length > 5000) issues.push({ column: 'description', code: 'too_long' });
        const due = parseDue(cells.dueAt ?? '');
        if (due === 'invalid') issues.push({ column: 'dueAt', code: 'invalid_date' });
        if (issues.length > 0) return { issues };
        return { value: { title, description: description === '' ? null : description, dueAt: due as Date | null }, issues };
      },
      async insert(tx: Prisma.TransactionClient, actor, values, csvJobId) {
        if (values.length > MAX_IMPORT_ROWS) throw new Error('too many rows');
        for (const v of values as ImportedTask[]) await tasks.createIn(tx, actor, v, { csvJobId });
      },
    },
  };
}
