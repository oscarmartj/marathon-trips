import { Inject, Injectable } from '@nestjs/common';
import type { ExportIssue, OrganiserExportBody } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound, unprocessable } from '../../platform/http/api-error';
import { FORMATS, formatsForRace, type FormatDefinition } from './formats';
import { loadRunners } from './reader';
import { problemsOf, renderCsv, safeFilename } from './render';

type Tx = Prisma.TransactionClient;

interface EditionInfo {
  id: string;
  raceId: string;
  raceSlug: string;
  raceName: string;
  year: number;
}

export interface CheckResult {
  runners: number;
  ready: number;
  /** Places left out because the traveller was erased. */
  erased: number;
  issues: ExportIssue[];
}

export type GenerateResult =
  | { kind: 'file'; filename: string; body: string; rowCount: number; excluded: number }
  | { kind: 'issues'; issues: ExportIssue[] };

const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const nameOf = (v: unknown): string => {
  if (typeof v === 'string') return v;
  const o = (v ?? {}) as Record<string, unknown>;
  const pick = o['en-AU'] ?? o.en ?? Object.values(o).find((x) => typeof x === 'string');
  return typeof pick === 'string' ? pick : '';
};

/**
 * Organiser exports (task 7.2). Reads runners and writes one audit row per generated file; nothing else is stored.
 * The file lives only in the response.
 */
@Injectable()
export class OrganiserExportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async edition(tx: Tx, editionId: string): Promise<EditionInfo> {
    const e = await tx.raceEdition.findFirst({ where: { id: editionId, race: { deletedAt: null } }, select: { id: true, year: true, race: { select: { id: true, slug: true, name: true } } } });
    if (!e) throw notFound('edition_not_found', 'Edition not found');
    return { id: e.id, raceId: e.race.id, raceSlug: e.race.slug, raceName: nameOf(e.race.name), year: e.year };
  }

  /** Unknown, and a format that is not for this race, are the same answer: formats of other races are not revealed. */
  private format(ed: EditionInfo, formatId: string): FormatDefinition {
    const f = formatsForRace(ed.raceSlug, FORMATS).find((x) => x.id === formatId);
    if (!f) throw notFound('format_not_found', 'Format not found');
    return f;
  }

  private async distance(tx: Tx, ed: EditionInfo, raceDistanceId: string | undefined): Promise<void> {
    if (raceDistanceId && !(await tx.raceDistance.findFirst({ where: { id: raceDistanceId, raceId: ed.raceId }, select: { id: true } }))) throw notFound('distance_not_found', 'Distance not found');
  }

  async formats(editionId: string) {
    return this.prisma.$transaction(async (tx) => {
      const ed = await this.edition(tx, editionId);
      return {
        edition: { id: ed.id, raceName: ed.raceName, year: ed.year },
        formats: formatsForRace(ed.raceSlug, FORMATS).map((f) => ({
          id: f.id, label: f.label, organiser: f.organiser,
          encoding: { charset: 'utf-8', bom: f.file.bom, delimiter: f.file.delimiter },
          columns: f.columns.map((c) => ({ header: c.header, required: c.required })),
        })),
      };
    });
  }

  private async prepare(tx: Tx, body: OrganiserExportBody) {
    const ed = await this.edition(tx, body.editionId);
    const format = this.format(ed, body.formatId);
    await this.distance(tx, ed, body.raceDistanceId);
    const loaded = await loadRunners(tx, format, ed, body.raceDistanceId);
    const checked = loaded.rows.map((r) => ({ ...r, problems: problemsOf(format, r.runner) }));
    const issues: ExportIssue[] = checked.filter((r) => r.problems.length > 0).map((r) => ({ reference: r.reference, slot: r.slot, problems: r.problems }));
    return { ed, format, loaded, issues };
  }

  /** The dry run: counts and per-runner problems, with no personal value in the answer. */
  async check(body: OrganiserExportBody): Promise<CheckResult> {
    return this.prisma.$transaction(async (tx) => {
      const { loaded, issues } = await this.prepare(tx, body);
      return { runners: loaded.rows.length, ready: loaded.rows.length - issues.length, erased: loaded.erased, issues };
    });
  }

  /**
   * The file. Reads and checks again inside the transaction (a runner erased since the check is not exported), and writes
   * the audit entry in the same transaction: no entry, no file. Problems write nothing, because nothing left.
   */
  async generate(actor: AuditActor & { id: string }, body: OrganiserExportBody): Promise<GenerateResult> {
    return this.prisma.$transaction(async (tx) => {
      const { ed, format, loaded, issues } = await this.prepare(tx, body);
      if (loaded.rows.length === 0) throw unprocessable('no_runners', 'No runners are ready to export for this edition');
      if (issues.length > 0) return { kind: 'issues', issues } as const;
      const csv = renderCsv(format, loaded.rows.map((r) => r.runner));
      await this.audit.record(tx, {
        actor, action: 'exports.runnerData.generated', entityType: 'RaceEdition', entityId: ed.id,
        // Who was in the file, for a breach notice or a runner asking who got their data: the booking reference (random,
        // @nopii) and the place, never a name or a value from the file (7.fix-3).
        after: { formatId: format.id, raceDistanceId: body.raceDistanceId ?? null, rowCount: loaded.rows.length, places: loaded.rows.map((r) => ({ reference: r.reference, slot: r.slot })) },
        fieldClasses: { formatId: 'nopii', raceDistanceId: 'nopii', rowCount: 'nopii', places: 'nopii' },
      });
      return { kind: 'file', filename: safeFilename(ed.raceSlug, ed.year, format.id, today()), body: csv, rowCount: loaded.rows.length, excluded: loaded.erased } as const;
    });
  }
}
