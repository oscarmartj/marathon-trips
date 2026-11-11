import { FILTER_OPS_BY_TYPE, type FilterOp, type TableFilter, type TableQuery, type TableSort } from '@mt/shared';
import { unprocessable } from '../http/api-error';
import type { TableColumn, TableDef } from './table-def';

type Where = Record<string, unknown>;

const column = (def: TableDef, key: string): TableColumn => {
  const c = def.columns.find((x) => x.key === key);
  if (!c) throw unprocessable('unknown_field', 'That field is not available on this table');
  return c;
};

function scalar(c: TableColumn, v: unknown): string | number | boolean | Date {
  switch (c.type) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw unprocessable('bad_filter_value', 'That filter value is not valid');
      return v;
    case 'boolean':
      if (typeof v !== 'boolean') throw unprocessable('bad_filter_value', 'That filter value is not valid');
      return v;
    case 'date': {
      const d = typeof v === 'string' ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) throw unprocessable('bad_filter_value', 'That filter value is not valid');
      return d;
    }
    case 'enum':
      if (typeof v !== 'string' || !c.values?.includes(v)) throw unprocessable('bad_filter_value', 'That filter value is not valid');
      return v;
    default:
      if (typeof v !== 'string') throw unprocessable('bad_filter_value', 'That filter value is not valid');
      return v;
  }
}

/** One filter as a Prisma condition. Throws 422 for an unknown field, an operator the type does not accept or a bad value. */
export function filterToWhere(def: TableDef, f: TableFilter): Where {
  const c = column(def, f.field);
  if (!c.filterable) throw unprocessable('unknown_field', 'That field cannot be filtered');
  if (!(FILTER_OPS_BY_TYPE[c.type] as readonly string[]).includes(f.op)) throw unprocessable('bad_filter_operator', 'That operator does not apply to this field');
  const op = f.op as FilterOp;
  const empty: Where = c.type === 'text' ? { OR: [{ [c.key]: null }, { [c.key]: '' }] } : { [c.key]: null };
  switch (op) {
    case 'empty':
      return empty;
    case 'notEmpty':
      return { NOT: empty };
    case 'in': {
      if (!Array.isArray(f.value) || f.value.length === 0) throw unprocessable('bad_filter_value', 'That filter value is not valid');
      return { [c.key]: { in: f.value.map((v) => scalar(c, v)) } };
    }
    case 'eq':
      return { [c.key]: scalar(c, f.value) };
    case 'neq':
      return { NOT: { [c.key]: scalar(c, f.value) } };
    case 'contains':
    case 'startsWith':
      return { [c.key]: { [op]: scalar(c, f.value), mode: 'insensitive' } };
    default:
      return { [c.key]: { [op]: scalar(c, f.value) } };
  }
}

export function sortToOrderBy(def: TableDef, sort: readonly TableSort[]): Array<Record<string, unknown>> {
  const out = sort.map((s) => {
    const c = column(def, s.field);
    if (!c.sortable) throw unprocessable('unknown_field', 'That field cannot be sorted');
    return { [c.key]: c.nullable ? { sort: s.dir, nulls: 'last' } : s.dir };
  });
  return [...out, { id: 'asc' }];
}

/** Checks a query (also the content of a saved view) against the table's whitelist without building anything. */
export function validateQuery(def: TableDef, q: TableQuery): void {
  q.filters.forEach((f) => filterToWhere(def, f));
  sortToOrderBy(def, q.sort);
  if (q.deleted !== 'exclude' && !def.softDelete) throw unprocessable('bad_deleted_option', 'This table has no deleted records');
}

export function buildWhere(def: TableDef, q: TableQuery, taggedIds: string[] | null): Where {
  const and: Where[] = q.filters.map((f) => filterToWhere(def, f));
  const text = q.q?.trim();
  if (text) {
    const cols = def.columns.filter((c) => c.searchable);
    and.push({ OR: cols.map((c) => ({ [c.key]: { contains: text, mode: 'insensitive' } })) });
  }
  if (def.softDelete) {
    if (q.deleted === 'exclude') and.push({ deletedAt: null });
    if (q.deleted === 'only') and.push({ NOT: { deletedAt: null } });
  }
  if (taggedIds) and.push({ id: { in: taggedIds } });
  return and.length ? { AND: and } : {};
}
