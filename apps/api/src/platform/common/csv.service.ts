import { MAX_IMPORT_ROWS, type TableQuery } from '@mt/shared';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { CsvParseError, parseCsv, toCsv, unguardCell, type CsvValue } from './csv';
import { type Caller, TableAccessService } from './table-access.service';
import { TablesService } from './tables.service';
import type { Row, TableDef } from './table-def';
import { notFound } from '../http/api-error';

export interface CsvError {
  row: number;
  column: string;
  code: string;
}

const MAX_ERRORS = 100;

@Injectable()
export class CsvService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TableAccessService) private readonly access: TableAccessService,
    @Inject(TablesService) private readonly tables: TablesService,
  ) {}

  async export(caller: Caller, def: TableDef, query: TableQuery) {
    await this.access.require(caller, def, 'export');
    const { rows, tags } = await this.tables.all(caller, def, query);
    const cols = def.columns.filter((c) => c.exportable);
    const header = [...cols.map((c) => c.key), ...(def.taggable ? ['tags'] : [])];
    const body = rows.map((r: Row) => [
      ...cols.map((c) => r[c.key] as CsvValue),
      ...(def.taggable ? [(tags.get(r.id as string) ?? []).map((t) => t.name).join('; ')] : []),
    ]);
    const csv = toCsv(header, body);
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.csvJob.create({ data: { entityType: def.entityType, kind: 'export', status: 'completed', stats: { rows: rows.length }, createdById: caller.actor.id } });
      await this.audit.record(tx, { actor: caller.actor, action: 'common.csv.exported', entityType: 'CsvJob', entityId: job.id, context: { table: def.entityType, rows: rows.length } });
    });
    return { csv, rows: rows.length };
  }

  /** Validates every row first; with dryRun false and no error, writes all rows in one transaction. */
  async import(caller: Caller, def: TableDef, input: { csv: string; dryRun: boolean }) {
    await this.access.require(caller, def, 'import');
    const spec = def.import;
    if (!spec) throw notFound('unknown_table', 'Table not found');
    const errors: CsvError[] = [];
    const values: unknown[] = [];
    let rowCount = 0;
    try {
      const [head, ...data] = parseCsv(input.csv);
      const header = head!.map((h) => h.trim());
      const allowed = new Set([...spec.columns, ...spec.ignored]);
      header.forEach((h, i) => {
        if (header.indexOf(h) !== i) errors.push({ row: 0, column: h, code: 'duplicate_column' });
        else if (!allowed.has(h)) errors.push({ row: 0, column: h, code: 'unknown_column' });
      });
      for (const r of spec.required) if (!header.includes(r)) errors.push({ row: 0, column: r, code: 'missing_column' });
      rowCount = data.length;
      if (data.length === 0) errors.push({ row: 0, column: '', code: 'no_rows' });
      if (data.length > MAX_IMPORT_ROWS) errors.push({ row: 0, column: '', code: 'too_many_rows' });
      if (errors.length === 0) {
        data.forEach((cells, i) => {
          if (cells.length !== header.length) {
            errors.push({ row: i + 1, column: '', code: 'wrong_cell_count' });
            return;
          }
          const byName: Record<string, string> = {};
          header.forEach((h, j) => {
            if (spec.columns.includes(h)) byName[h] = unguardCell(cells[j]!.trim());
          });
          const parsed = spec.parseRow(byName);
          for (const issue of parsed.issues) errors.push({ row: i + 1, ...issue });
          if (parsed.issues.length === 0) values.push(parsed.value);
        });
      }
    } catch (e) {
      if (!(e instanceof CsvParseError)) throw e;
      errors.push({ row: 0, column: '', code: e.code });
    }
    const shown = errors.slice(0, MAX_ERRORS);
    const stats = { rows: rowCount, errors: errors.length };
    if (errors.length > 0) {
      const job = await this.prisma.csvJob.create({ data: { entityType: def.entityType, kind: 'import', status: 'failed', stats, errors: shown as unknown as Prisma.InputJsonValue, createdById: caller.actor.id } });
      return { valid: false, committed: false, rows: rowCount, errors: shown as unknown as Prisma.InputJsonValue, jobId: job.id };
    }
    if (input.dryRun) {
      const job = await this.prisma.csvJob.create({ data: { entityType: def.entityType, kind: 'import', status: 'previewed', stats, createdById: caller.actor.id } });
      return { valid: true, committed: false, rows: rowCount, errors: [], jobId: job.id };
    }
    const jobId = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const job = await tx.csvJob.create({ data: { entityType: def.entityType, kind: 'import', status: 'completed', stats, createdById: caller.actor.id } });
      await spec.insert(tx, caller.actor, values, job.id);
      await this.audit.record(tx, { actor: caller.actor, action: 'common.csv.imported', entityType: 'CsvJob', entityId: job.id, context: { table: def.entityType, rows: rowCount } });
      return job.id;
    });
    return { valid: true, committed: true, rows: rowCount, errors: [], jobId };
  }
}
