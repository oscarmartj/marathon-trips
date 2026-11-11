import { z } from 'zod';
import { reasonSchema } from './auth';

// Request shapes of the shared table capabilities (task 0.5): shared by the API (validation) and the panel.

export const COLUMN_TYPES = ['text', 'number', 'date', 'boolean', 'enum'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/** Operators each column type accepts. The API refuses anything else. */
export const FILTER_OPS_BY_TYPE = {
  text: ['eq', 'neq', 'contains', 'startsWith', 'in', 'empty', 'notEmpty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'],
  date: ['gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'],
  boolean: ['eq'],
  enum: ['eq', 'neq', 'in'],
} as const satisfies Record<ColumnType, readonly string[]>;
export const ALL_FILTER_OPS = ['eq', 'neq', 'contains', 'startsWith', 'in', 'empty', 'notEmpty', 'gt', 'gte', 'lt', 'lte'] as const;
export type FilterOp = (typeof ALL_FILTER_OPS)[number];

export const MAX_PAGE_SIZE = 100;
export const MAX_BULK_IDS = 100;
export const MAX_EXPORT_ROWS = 5000;
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_CHARS = 90_000;

const key = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/);
const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const filterSchema = z.strictObject({
  field: key,
  op: z.enum(ALL_FILTER_OPS),
  value: z.union([scalar, z.array(z.union([z.string().max(200), z.number().finite()])).max(50)]).optional(),
});
export const sortSchema = z.strictObject({ field: key, dir: z.enum(['asc', 'desc']) });
export type TableFilter = z.infer<typeof filterSchema>;
export type TableSort = z.infer<typeof sortSchema>;

const uuids = z.array(z.uuid()).max(20);

/** The parsed query every capability shares (list, export, saved view content). */
export const tableQueryShape = z.strictObject({
  q: z.string().trim().max(100).optional(),
  filters: z.array(filterSchema).max(10).default([]),
  sort: z.array(sortSchema).max(3).default([]),
  tagIds: uuids.default([]),
  tagMode: z.enum(['any', 'all']).default('any'),
  deleted: z.enum(['exclude', 'include', 'only']).default('exclude'),
});
export type TableQuery = z.infer<typeof tableQueryShape>;

export const pageShape = z.strictObject({
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return '__invalid__';
  }
}

/** Query string form: `filters` is JSON, `sort` is `field:dir,field:dir`, `tags` is comma-separated ids. */
const listParamsRaw = z.strictObject({
  q: z.string().optional(),
  filters: z.string().max(4000).optional(),
  sort: z.string().max(200).optional(),
  tags: z.string().max(800).optional(),
  tagMode: z.string().optional(),
  deleted: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

export const tableListParamsSchema = z.preprocess(
  (raw): unknown => {
    const r = listParamsRaw.safeParse(raw ?? {});
    if (!r.success) return '__invalid__';
    const p = r.data;
    return {
      query: {
        q: p.q,
        filters: p.filters ? parseJson(p.filters) : [],
        sort: p.sort ? p.sort.split(',').filter(Boolean).map((s) => ({ field: s.split(':')[0], dir: s.split(':')[1] ?? 'asc' })) : [],
        tagIds: p.tags ? p.tags.split(',').filter(Boolean) : [],
        tagMode: p.tagMode,
        deleted: p.deleted,
      },
      paging: { page: p.page === undefined ? undefined : Number(p.page), pageSize: p.pageSize === undefined ? undefined : Number(p.pageSize) },
    };
  },
  z.object({ query: tableQueryShape, paging: pageShape }),
);
export type TableListParams = { query: TableQuery; paging: z.infer<typeof pageShape> };

export const exportBodySchema = z.strictObject({ query: tableQueryShape.default({ filters: [], sort: [], tagIds: [], tagMode: 'any', deleted: 'exclude' }) });

export const savedViewInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  query: tableQueryShape,
  columns: z.array(key).max(40).default([]),
  shared: z.boolean().default(false),
});
export const savedViewUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  query: tableQueryShape.optional(),
  columns: z.array(key).max(40).optional(),
  shared: z.boolean().optional(),
  version: z.number().int().min(0),
});

export const bulkSchema = z.strictObject({ action: key, ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS), reason: reasonSchema });
export const csvImportSchema = z.strictObject({ csv: z.string().max(MAX_IMPORT_CHARS), dryRun: z.boolean() });
export const deleteRecordSchema = z.strictObject({ reason: reasonSchema });

export const tagColourSchema = z.string().regex(/^#[0-9a-f]{6}$/);
export const tagInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  colour: tagColourSchema,
  entityTypes: z.array(z.string().regex(/^[A-Za-z]{1,40}$/)).max(20).default([]),
});
export const tagUpdateSchema = tagInputSchema.partial();
export const setTagsSchema = z.strictObject({ tagIds: uuids, reason: reasonSchema });

export const noteInputSchema = z.strictObject({ body: z.string().trim().min(1).max(5000), pinned: z.boolean().default(false) });
export const noteUpdateSchema = z.strictObject({ body: z.string().trim().min(1).max(5000).optional(), pinned: z.boolean().optional(), version: z.number().int().min(0) });

export const searchParamsSchema = z.strictObject({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const dueAt = z.union([z.iso.datetime({ offset: true }), z.iso.date()]).nullable();
export const taskInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  dueAt: dueAt.optional(),
  assigneeId: z.uuid().nullable().optional(),
});
export const taskUpdateSchema = z.strictObject({
  version: z.number().int().min(0),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  dueAt: dueAt.optional(),
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  assigneeId: z.uuid().nullable().optional(),
  reason: reasonSchema,
});
