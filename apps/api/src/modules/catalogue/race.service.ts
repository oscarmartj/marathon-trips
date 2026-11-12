import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type {
  adminRaceQuerySchema, createEditionSchema, createRaceSchema, distanceSchema, setClaimSchema, updateDistanceSchema, updateEditionSchema, updateRaceSchema,
} from '@mt/shared';
import type { ClaimKind, EditionStatus, RaceStatus } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor, AuditContext } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { CatalogueChangeGuards } from './open-gates';
import { EDITION_TRANSITIONS, RACE_TRANSITIONS, canMove } from './transitions';
import { Tx, assertVersion, defined, fromDate, orConflict, orInUse, toDate, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };

/** Races, their distances and claims, and their editions (plan 5.2). */
@Injectable()
export class RaceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CatalogueChangeGuards) private readonly changeGuards: CatalogueChangeGuards,
  ) {}

  // ---- Races ----

  async list(q: z.infer<typeof adminRaceQuerySchema>) {
    const where: Prisma.RaceWhereInput = {
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ slug: { contains: q.q, mode: 'insensitive' } }, { city: { contains: q.q, mode: 'insensitive' } }, { name: { path: ['en-AU'], string_contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.race.count({ where }),
      this.prisma.race.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { _count: { select: { editions: true } } } }),
    ]);
    return view({ items: rows.map(({ _count, ...r }) => ({ ...r, editionCount: _count.editions })), page: q.page, pageSize: q.pageSize, total });
  }

  async get(id: string) {
    const race = await this.prisma.race.findFirst({
      where: { id, deletedAt: null },
      include: { distances: { orderBy: { distanceMetres: 'desc' } }, claims: { orderBy: { kind: 'asc' } }, editions: { orderBy: { year: 'desc' } } },
    });
    if (!race) throw notFound('race_not_found', 'Race not found');
    return view(race);
  }

  async create(actor: Actor, input: z.infer<typeof createRaceSchema>) {
    const row = await orConflict('race_slug_taken', 'A race with this slug already exists', () => this.prisma.$transaction((tx) => this.createIn(tx, actor, input)));
    return this.get(row.id);
  }

  /** Creates a draft race in the caller's transaction (also used by the CSV import). `isDemo` is never taken from input. */
  async createIn(tx: Tx, actor: Actor, input: z.infer<typeof createRaceSchema>, context?: AuditContext) {
    const { reason, ...data } = input;
    const created = await tx.race.create({ data: { ...data, isDemo: false } });
    await this.audit.record(tx, { actor, action: 'catalogue.race.created', entityType: 'Race', entityId: created.id, reason, after: view(created), context });
    return created;
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateRaceSchema>) {
    const { version, reason, ...rest } = input;
    const patch = defined(rest);
    await orConflict('race_slug_taken', 'A race with this slug already exists', () =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.race.findFirst({ where: { id, deletedAt: null } });
        assertVersion(before, version, 'Race not found');
        const res = await tx.race.updateMany({ where: { id, version }, data: { ...patch, version: { increment: 1 } } });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.race.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'catalogue.race.updated', entityType: 'Race', entityId: id, reason, before: view(before), after: view(after) });
      }),
    );
    return this.get(id);
  }

  /** draft/published/archived by the table in transitions.ts; demo races never get to `published` (plan 6.1). */
  async setStatus(actor: Actor, id: string, input: { status: RaceStatus; version: number; reason?: string }) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.race.findFirst({ where: { id, deletedAt: null } });
      assertVersion(before, input.version, 'Race not found');
      if (!canMove(RACE_TRANSITIONS, before.status as RaceStatus, input.status)) throw conflict('transition_not_allowed', 'This status change is not allowed');
      if (input.status === 'published' && before.isDemo) throw conflict('demo_cannot_be_published', 'Demo data cannot be published');
      const res = await tx.race.updateMany({
        where: { id, version: input.version, status: before.status },
        data: { status: input.status, version: { increment: 1 }, ...(input.status === 'published' ? { publishedAt: new Date() } : {}) },
      });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.race.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action: 'catalogue.race.status_changed', entityType: 'Race', entityId: id, reason: input.reason, before: { status: before.status }, after: { status: after.status } });
      if (input.status === 'published') {
        await this.outbox.publish(tx, { type: 'catalogue.race.published', aggregateType: 'Race', aggregateId: id, aggregateVersion: after.version, actorType: actor.type, actorId: actor.id });
      }
    });
    return this.get(id);
  }

  /** Soft delete; only a draft race with no editions. The slug stays reserved until restore (0.5). */
  async remove(actor: Actor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const race = await tx.race.findFirst({ where: { id, deletedAt: null }, include: { _count: { select: { editions: true } } } });
      if (!race) throw notFound('race_not_found', 'Race not found');
      if (race.status !== 'draft') throw conflict('race_not_draft', 'Only a draft race can be deleted');
      if (race._count.editions > 0) throw conflict('race_has_editions', 'Delete or move the editions first');
      const res = await tx.race.updateMany({ where: { id, status: 'draft', deletedAt: null }, data: { deletedAt: new Date(), deletedById: actor.id, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      await this.audit.record(tx, { actor, action: 'catalogue.race.deleted', entityType: 'Race', entityId: id, reason, before: { deletedAt: null }, after: { deletedAt: new Date() } });
    });
  }

  private async liveRace(tx: Tx, id: string) {
    const race = await tx.race.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!race) throw notFound('race_not_found', 'Race not found');
    return race;
  }

  // ---- Distances ----

  async addDistance(actor: Actor, raceId: string, input: z.infer<typeof distanceSchema>) {
    return view(
      await this.prisma.$transaction(async (tx) => {
        await this.liveRace(tx, raceId);
        const row = await tx.raceDistance.create({ data: { ...input, raceId } });
        await this.audit.record(tx, { actor, action: 'catalogue.distance.created', entityType: 'RaceDistance', entityId: row.id, after: view(row) });
        return row;
      }),
    );
  }

  async updateDistance(actor: Actor, id: string, input: z.infer<typeof updateDistanceSchema>) {
    return view(
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.raceDistance.findFirst({ where: { id, race: { deletedAt: null } } });
        if (!before) throw notFound('distance_not_found', 'Distance not found');
        const after = await tx.raceDistance.update({ where: { id }, data: defined(input) });
        await this.audit.record(tx, { actor, action: 'catalogue.distance.updated', entityType: 'RaceDistance', entityId: id, before: view(before), after: view(after) });
        return after;
      }),
    );
  }

  async removeDistance(actor: Actor, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.raceDistance.findFirst({ where: { id, race: { deletedAt: null } }, include: { _count: { select: { entryOptions: true } } } });
      if (!before) throw notFound('distance_not_found', 'Distance not found');
      if (before._count.entryOptions > 0) throw conflict('distance_in_use', 'A package uses this distance for its race entries');
      const guard = await this.changeGuards.firstFailure(tx, { kind: 'distance', raceDistanceId: id });
      if (guard) throw conflict(guard.code, guard.message);
      const { _count, ...row } = before;
      await orInUse('distance_in_use', 'Something still uses this distance', () => tx.raceDistance.delete({ where: { id } }));
      await this.audit.record(tx, { actor, action: 'catalogue.distance.deleted', entityType: 'RaceDistance', entityId: id, before: view(row) });
    });
  }

  // ---- Claims ----

  /**
   * The only source of any badge on the website (plan 5.2). Turning one on needs a written evidence note; the change is
   * audited with the previous and the new value. `guaranteed_entry` also needs confirmed stock to show (see public reads).
   */
  async setClaim(actor: Actor, raceId: string, kind: ClaimKind, input: z.infer<typeof setClaimSchema>) {
    if (input.enabled && input.evidenceNote.length === 0) throw unprocessable('evidence_required', 'Write down the evidence before turning a claim on');
    return view(
      await this.prisma.$transaction(async (tx) => {
        await this.liveRace(tx, raceId);
        const before = await tx.raceClaim.findUnique({ where: { raceId_kind: { raceId, kind } } });
        const data = {
          enabled: input.enabled,
          evidenceNote: input.evidenceNote,
          enabledAt: input.enabled ? (before?.enabled ? before.enabledAt : new Date()) : null,
          enabledById: input.enabled ? (before?.enabled ? before.enabledById : actor.id) : null,
        };
        const after = before
          ? await tx.raceClaim.update({ where: { id: before.id }, data })
          : await tx.raceClaim.create({ data: { raceId, kind, ...data } });
        await this.audit.record(tx, {
          actor, action: 'catalogue.claim.changed', entityType: 'RaceClaim', entityId: after.id, reason: input.reason,
          before: before ? view({ kind, enabled: before.enabled, evidenceNote: before.evidenceNote }) : null,
          after: view({ kind, enabled: after.enabled, evidenceNote: after.evidenceNote }),
        });
        return after;
      }),
    );
  }

  // ---- Editions ----

  private checkEditionDates(start: string | null, end: string | null, dateStatus: string): void {
    if (start && end && end < start) throw unprocessable('edition_dates_invalid', 'The end date is before the start date');
    if (dateStatus === 'confirmed' && !start) throw unprocessable('edition_confirmed_needs_date', 'A confirmed date needs a start date');
  }

  async createEdition(actor: Actor, raceId: string, input: z.infer<typeof createEditionSchema>) {
    const { reason, startDate, endDate, ...rest } = input;
    this.checkEditionDates(startDate, endDate, rest.dateStatus);
    const row = await orConflict('edition_year_taken', 'This race already has an edition for that year', () =>
      this.prisma.$transaction(async (tx) => {
        await this.liveRace(tx, raceId);
        const created = await tx.raceEdition.create({ data: { ...rest, raceId, startDate: startDate ? toDate(startDate) : null, endDate: endDate ? toDate(endDate) : null } });
        await this.audit.record(tx, { actor, action: 'catalogue.edition.created', entityType: 'RaceEdition', entityId: created.id, reason, after: view(created) });
        return created;
      }),
    );
    return view(row);
  }

  async getEdition(id: string) {
    const e = await this.prisma.raceEdition.findFirst({
      where: { id, race: { deletedAt: null } },
      include: { packages: { where: { deletedAt: null }, orderBy: { slug: 'asc' } }, pools: { orderBy: { createdAt: 'asc' } } },
    });
    if (!e) throw notFound('edition_not_found', 'Edition not found');
    return view(e);
  }

  async updateEdition(actor: Actor, id: string, input: z.infer<typeof updateEditionSchema>) {
    const { version, reason, startDate, endDate, ...rest } = input;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.raceEdition.findFirst({ where: { id, race: { deletedAt: null } } });
      assertVersion(before, version, 'Edition not found');
      const nextStart = startDate === undefined ? fromDate(before.startDate) : startDate;
      const nextEnd = endDate === undefined ? fromDate(before.endDate) : endDate;
      this.checkEditionDates(nextStart, nextEnd, rest.dateStatus ?? before.dateStatus);
      const res = await tx.raceEdition.updateMany({
        where: { id, version },
        data: {
          ...defined(rest),
          ...(startDate === undefined ? {} : { startDate: startDate ? toDate(startDate) : null }),
          ...(endDate === undefined ? {} : { endDate: endDate ? toDate(endDate) : null }),
          version: { increment: 1 },
        },
      });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.raceEdition.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action: 'catalogue.edition.updated', entityType: 'RaceEdition', entityId: id, reason, before: view(before), after: view(after) });
    });
    return this.getEdition(id);
  }

  async setEditionStatus(actor: Actor, id: string, input: { status: EditionStatus; version: number; reason?: string }) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.raceEdition.findFirst({ where: { id, race: { deletedAt: null } } });
      assertVersion(before, input.version, 'Edition not found');
      if (!canMove(EDITION_TRANSITIONS, before.status as EditionStatus, input.status)) throw conflict('transition_not_allowed', 'This status change is not allowed');
      const res = await tx.raceEdition.updateMany({ where: { id, version: input.version, status: before.status }, data: { status: input.status, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      await this.audit.record(tx, { actor, action: 'catalogue.edition.status_changed', entityType: 'RaceEdition', entityId: id, reason: input.reason, before: { status: before.status }, after: { status: input.status } });
    });
    return this.getEdition(id);
  }

  /** Hard delete of an empty draft edition (no packages, not even deleted ones, and no stock pools). */
  async removeEdition(actor: Actor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const e = await tx.raceEdition.findFirst({ where: { id, race: { deletedAt: null } }, include: { _count: { select: { packages: true, pools: true } } } });
      if (!e) throw notFound('edition_not_found', 'Edition not found');
      if (e.status !== 'draft') throw conflict('edition_not_draft', 'Only a draft edition can be deleted');
      if (e._count.packages > 0 || e._count.pools > 0) throw conflict('edition_not_empty', 'Remove the packages and stock pools first');
      const { _count, ...row } = e;
      await tx.raceEdition.delete({ where: { id } });
      await this.audit.record(tx, { actor, action: 'catalogue.edition.deleted', entityType: 'RaceEdition', entityId: id, reason, before: view(row) });
    });
  }
}
