import { Inject, Injectable } from '@nestjs/common';
import { MAX_IMPORT_ROWS, createPackageSchema, createRaceSchema, RACE_TYPES, type CustomFieldValues } from '@mt/shared';
import type { z } from 'zod';
import type { AuditActor } from '../../platform/audit/audit.service';
import { CsvParseError, parseCsv, toCsv, unguardCell } from '../../platform/common/csv';
import { CustomFieldsService } from '../../platform/common/custom-fields/custom-fields.service';
import type { RuleDef } from '../../platform/common/custom-fields/values';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound } from '../../platform/http/api-error';
import { orConflict, fromDate } from './support';
import type { Tx } from './support';
import { PackageService } from './package.service';
import { RaceService } from './race.service';

type Actor = AuditActor & { id: string };
type Cells = Record<string, string>;
export interface CsvIssue {
  column: string;
  code: string;
}
export interface CsvError extends CsvIssue {
  row: number;
}
export interface ImportResult {
  valid: boolean;
  committed: boolean;
  rows: number;
  errors: CsvError[];
}

const MAX_ERRORS = 100;
const enAU = (v: unknown): string => (v && typeof v === 'object' && typeof (v as Record<string, unknown>)['en-AU'] === 'string' ? ((v as Record<string, string>)['en-AU'] as string) : '');
const text = (s: string) => ({ 'en-AU': s });
const orNull = (s: string | undefined): string | null => (s === undefined || s === '' ? null : s);

interface Spec<T> {
  columns: readonly string[];
  /** Columns an export carries that an import reads and ignores, so an exported file can be imported again. */
  ignored: readonly string[];
  required: readonly string[];
  parse(cells: Cells): { value?: T; issues: CsvIssue[] };
  slugOf(value: T): string;
  /** Slugs that are already taken where the rows would be written. */
  taken(slugs: string[]): Promise<Set<string>>;
  insert(tx: Tx, values: T[]): Promise<void>;
}

/** Zod issues become column codes. No value from the file ever leaves this function. */
function zodIssues(error: z.ZodError, columnOf: (key: string) => string): CsvIssue[] {
  const seen = new Set<string>();
  const out: CsvIssue[] = [];
  for (const i of error.issues) {
    const column = columnOf(String(i.path[0] ?? ''));
    const code = i.code === 'too_big' && i.origin === 'string' ? 'too_long' : 'invalid_value';
    if (!seen.has(`${column}:${code}`)) {
      seen.add(`${column}:${code}`);
      out.push({ column, code });
    }
  }
  return out;
}

/**
 * CSV for races and for the packages of one edition (task 1.2), in the shape of the shared table CSV (task 0.5): a check
 * run that writes nothing, errors by row and column without values, and all-or-nothing writes. Imports create drafts only.
 */
@Injectable()
export class CatalogueCsvService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RaceService) private readonly races: RaceService,
    @Inject(PackageService) private readonly packages: PackageService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
  ) {}

  // ---- Custom fields (task 7.5): one `cf:<key>` column per active definition, in both directions ----

  /** Reads the custom field cells of one row. Blank cells are skipped; a bad cell is reported by column and code, never by value. */
  private readCustomFields(cols: Array<{ column: string; def: RuleDef }>, c: Cells): { values: CustomFieldValues; issues: CsvIssue[] } {
    const values: CustomFieldValues = {};
    const issues: CsvIssue[] = [];
    for (const { column, def } of cols) {
      const res = this.customFields.csvParse(def, c[column] ?? '');
      if ('blank' in res) continue;
      if (res.ok) values[def.key] = res.value;
      else issues.push({ column, code: `custom_field_${res.code}` });
    }
    return { values, issues };
  }

  // ---- Races ----

  async exportRaces(): Promise<{ csv: string; rows: number }> {
    const rows = await this.prisma.race.findMany({ where: { deletedAt: null }, orderBy: [{ slug: 'asc' }], take: 5000, include: { _count: { select: { editions: true } } } });
    const cf = await this.customFields.csvColumns('Race');
    const header = ['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'typicalMonth', 'summary', 'websiteUrl', 'status', 'editionCount', ...cf.map((c) => c.column)];
    const body = rows.map((r) => [r.slug, enAU(r.name), r.countryCode, r.city, r.timeZone, r.raceType, r.typicalMonth, enAU(r.summary), r.websiteUrl, r.status, r._count.editions, ...cf.map((c) => this.customFields.csvCell(c.def, r.customFields))]);
    return { csv: toCsv(header, body), rows: rows.length };
  }

  async importRaces(actor: Actor, input: { csv: string; dryRun: boolean }): Promise<ImportResult> {
    const cf = await this.customFields.csvColumns('Race');
    const spec: Spec<z.infer<typeof createRaceSchema>> = {
      columns: ['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'typicalMonth', 'summary', 'websiteUrl', ...cf.map((c) => c.column)],
      ignored: ['status', 'editionCount'],
      required: ['slug', 'name', 'countryCode', 'city', 'timeZone', 'raceType', 'summary', ...cf.filter((c) => c.def.required).map((c) => c.column)],
      parse: (c) => {
        const month = orNull(c.typicalMonth);
        if (month !== null && !/^\d{1,2}$/.test(month)) return { issues: [{ column: 'typicalMonth', code: 'invalid_value' }] };
        if (c.raceType && !(RACE_TYPES as readonly string[]).includes(c.raceType)) return { issues: [{ column: 'raceType', code: 'invalid_value' }] };
        const parsed = createRaceSchema.safeParse({
          slug: c.slug, name: text(c.name ?? ''), countryCode: c.countryCode, city: c.city, timeZone: c.timeZone, raceType: c.raceType,
          typicalMonth: month === null ? null : Number(month), summary: text(c.summary ?? ''), websiteUrl: orNull(c.websiteUrl),
        });
        if (!parsed.success) return { issues: zodIssues(parsed.error, (k) => k) };
        const custom = this.readCustomFields(cf, c);
        return custom.issues.length > 0 ? { issues: custom.issues } : { value: { ...parsed.data, customFields: custom.values }, issues: [] };
      },
      slugOf: (v) => v.slug,
      taken: async (slugs) => new Set((await this.prisma.race.findMany({ where: { slug: { in: slugs } }, select: { slug: true } })).map((r) => r.slug)),
      insert: async (tx, values) => {
        for (const v of values) await this.races.createIn(tx, actor, v, { source: 'csv' });
      },
    };
    return this.runImport(spec, input);
  }

  // ---- Packages of one edition ----

  async exportPackages(editionId: string): Promise<{ csv: string; rows: number }> {
    await this.edition(editionId);
    const rows = await this.prisma.package.findMany({ where: { editionId, deletedAt: null }, orderBy: [{ slug: 'asc' }], take: 5000 });
    const cf = await this.customFields.csvColumns('Package');
    const header = [
      'slug', 'name', 'checkInDate', 'checkOutDate', 'balanceDueDate', 'minTravellers', 'maxTravellers', 'maxExtraNightsBefore', 'maxExtraNightsAfter', 'instantBooking', 'autoConfirmOnDeposit',
      'saleStatus', 'depositMode', 'depositAmountMinor', 'depositBps', ...cf.map((c) => c.column),
    ];
    const body = rows.map((p) => [
      p.slug, enAU(p.name), fromDate(p.checkInDate), fromDate(p.checkOutDate), fromDate(p.balanceDueDate), p.minTravellers, p.maxTravellers, p.maxExtraNightsBefore, p.maxExtraNightsAfter,
      p.instantBooking, p.autoConfirmOnDeposit, p.saleStatus, p.depositMode, p.depositAmountMinor === null ? null : p.depositAmountMinor.toString(), p.depositBps,
      ...cf.map((c) => this.customFields.csvCell(c.def, p.customFields)),
    ]);
    return { csv: toCsv(header, body), rows: rows.length };
  }

  /** Packages arrive as drafts without a deposit: the deposit is money, so it is set in the panel, not from a file. */
  async importPackages(actor: Actor, editionId: string, input: { csv: string; dryRun: boolean }): Promise<ImportResult> {
    await this.edition(editionId);
    const cf = await this.customFields.csvColumns('Package');
    const int = (s: string | undefined): number | undefined => (s === undefined || s === '' ? undefined : /^\d{1,3}$/.test(s) ? Number(s) : Number.NaN);
    const bool = (s: string | undefined): boolean | undefined | null => (s === undefined || s === '' ? undefined : s === 'true' ? true : s === 'false' ? false : null);
    const spec: Spec<z.infer<typeof createPackageSchema>> = {
      columns: ['slug', 'name', 'checkInDate', 'checkOutDate', 'balanceDueDate', 'minTravellers', 'maxTravellers', 'maxExtraNightsBefore', 'maxExtraNightsAfter', 'instantBooking', 'autoConfirmOnDeposit', ...cf.map((c) => c.column)],
      ignored: ['saleStatus', 'depositMode', 'depositAmountMinor', 'depositBps'],
      required: ['slug', 'name', 'checkInDate', 'checkOutDate', 'balanceDueDate', 'maxTravellers', ...cf.filter((c) => c.def.required).map((c) => c.column)],
      parse: (c) => {
        const bad: CsvIssue[] = [];
        for (const k of ['minTravellers', 'maxTravellers', 'maxExtraNightsBefore', 'maxExtraNightsAfter'] as const) if (Number.isNaN(int(c[k]))) bad.push({ column: k, code: 'invalid_value' });
        for (const k of ['instantBooking', 'autoConfirmOnDeposit'] as const) if (bool(c[k]) === null) bad.push({ column: k, code: 'invalid_value' });
        if (bad.length > 0) return { issues: bad };
        const parsed = createPackageSchema.safeParse({
          slug: c.slug, name: text(c.name ?? ''), checkInDate: c.checkInDate, checkOutDate: c.checkOutDate, balanceDueDate: c.balanceDueDate,
          minTravellers: int(c.minTravellers), maxTravellers: int(c.maxTravellers), maxExtraNightsBefore: int(c.maxExtraNightsBefore), maxExtraNightsAfter: int(c.maxExtraNightsAfter),
          instantBooking: bool(c.instantBooking) ?? undefined, autoConfirmOnDeposit: bool(c.autoConfirmOnDeposit) ?? undefined,
        });
        if (!parsed.success) return { issues: zodIssues(parsed.error, (k) => k) };
        const v = parsed.data;
        const issues: CsvIssue[] = [];
        if (v.checkOutDate <= v.checkInDate) issues.push({ column: 'checkOutDate', code: 'package_dates_invalid' });
        if (v.balanceDueDate > v.checkInDate) issues.push({ column: 'balanceDueDate', code: 'balance_due_after_check_in' });
        if (v.maxTravellers < v.minTravellers) issues.push({ column: 'maxTravellers', code: 'travellers_range_invalid' });
        const custom = this.readCustomFields(cf, c);
        issues.push(...custom.issues);
        return issues.length > 0 ? { issues } : { value: { ...v, customFields: custom.values }, issues: [] };
      },
      slugOf: (v) => v.slug,
      taken: async (slugs) => new Set((await this.prisma.package.findMany({ where: { editionId, slug: { in: slugs } }, select: { slug: true } })).map((r) => r.slug)),
      insert: async (tx, values) => {
        for (const v of values) await this.packages.createIn(tx, actor, editionId, v, { source: 'csv' });
      },
    };
    return this.runImport(spec, input);
  }

  private async edition(id: string) {
    const e = await this.prisma.raceEdition.findFirst({ where: { id, race: { deletedAt: null } }, select: { id: true } });
    if (!e) throw notFound('edition_not_found', 'Edition not found');
  }

  private async runImport<T>(spec: Spec<T>, input: { csv: string; dryRun: boolean }): Promise<ImportResult> {
    const errors: CsvError[] = [];
    const values: Array<{ row: number; value: T }> = [];
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
          const byName: Cells = {};
          header.forEach((h, j) => {
            if (spec.columns.includes(h)) byName[h] = unguardCell(cells[j]!.trim());
          });
          const missing = spec.required.filter((r) => (byName[r] ?? '') === '');
          for (const column of missing) errors.push({ row: i + 1, column, code: 'required' });
          if (missing.length > 0) return;
          const parsed = spec.parse(byName);
          for (const issue of parsed.issues) errors.push({ row: i + 1, ...issue });
          if (parsed.issues.length === 0) values.push({ row: i + 1, value: parsed.value as T });
        });
      }
      if (errors.length === 0) {
        const seen = new Set<string>();
        for (const v of values) {
          const slug = spec.slugOf(v.value);
          if (seen.has(slug)) errors.push({ row: v.row, column: 'slug', code: 'duplicate_in_file' });
          seen.add(slug);
        }
        const taken = await spec.taken([...seen]);
        for (const v of values) if (taken.has(spec.slugOf(v.value))) errors.push({ row: v.row, column: 'slug', code: 'slug_taken' });
      }
    } catch (e) {
      if (!(e instanceof CsvParseError)) throw e;
      errors.push({ row: 0, column: '', code: e.code });
    }
    if (errors.length > 0) return { valid: false, committed: false, rows: rowCount, errors: errors.slice(0, MAX_ERRORS) };
    if (input.dryRun) return { valid: true, committed: false, rows: rowCount, errors: [] };
    await orConflict('slug_taken', 'A slug in the file is already taken', () => this.prisma.$transaction((tx) => spec.insert(tx, values.map((v) => v.value))));
    return { valid: true, committed: true, rows: rowCount, errors: [] };
  }
}
