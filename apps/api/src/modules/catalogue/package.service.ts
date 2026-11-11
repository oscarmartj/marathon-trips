import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type {
  SaleStatus, addPackageHotelSchema, createExtraSchema, createHotelSchema, createPackageSchema, depositSchema, entryOptionSchema, roomOptionSchema,
  setParticipationSchema, updateExtraSchema, updateHotelSchema, updatePackageSchema, updateRoomOptionSchema,
} from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { PackageOpenGates } from './open-gates';
import { LIVE_SALE_STATUSES, SALE_TRANSITIONS, canMove } from './transitions';
import { Tx, assertVersion, defined, fromDate, orConflict, toDate, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };
type Deposit = z.infer<typeof depositSchema>;

const depositColumns = (d: Deposit | null | undefined) =>
  d == null
    ? { depositMode: null, depositAmountMinor: null, depositBps: null }
    : d.mode === 'percent'
      ? { depositMode: d.mode, depositAmountMinor: null, depositBps: d.bps }
      : { depositMode: d.mode, depositAmountMinor: BigInt(d.amountMinor), depositBps: null };

/** The shape the API shows for a package's deposit (amount as a string of digits). */
export const depositView = (p: { depositMode: string | null; depositAmountMinor: bigint | null; depositBps: number | null }) =>
  p.depositMode === null ? null : p.depositMode === 'percent' ? { mode: 'percent', bps: p.depositBps } : { mode: p.depositMode, amountMinor: String(p.depositAmountMinor) };

const packageInclude = {
  edition: { select: { id: true, year: true, raceId: true, race: { select: { id: true, slug: true, isDemo: true, status: true } } } },
  participationOptions: { orderBy: { type: 'asc' } },
  entryOptions: { include: { raceDistance: true, entryPool: true }, orderBy: { createdAt: 'asc' } },
  hotels: { include: { hotel: true, rooms: { include: { roomPool: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] },
  extras: { where: { deletedAt: null }, include: { pool: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.PackageInclude;

/** Packages and what hangs off them: participation, entries, hotels, rooms and extras (plan 5.2), plus hotels themselves. */
@Injectable()
export class PackageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PackageOpenGates) private readonly gates: PackageOpenGates,
  ) {}

  // ---- Packages ----

  private checkDates(p: { checkInDate: string; checkOutDate: string; balanceDueDate: string; minTravellers: number; maxTravellers: number }): void {
    if (p.checkOutDate <= p.checkInDate) throw unprocessable('package_dates_invalid', 'Check-out must be after check-in');
    if (p.balanceDueDate > p.checkInDate) throw unprocessable('balance_due_after_check_in', 'The balance must be due on or before check-in');
    if (p.maxTravellers < p.minTravellers) throw unprocessable('travellers_range_invalid', 'The maximum travellers cannot be below the minimum');
  }

  async get(id: string) {
    const p = await this.prisma.package.findFirst({ where: { id, deletedAt: null, edition: { race: { deletedAt: null } } }, include: packageInclude });
    if (!p) throw notFound('package_not_found', 'Package not found');
    return view({ ...p, deposit: depositView(p) });
  }

  async create(actor: Actor, editionId: string, input: z.infer<typeof createPackageSchema>) {
    const { reason, deposit, ...rest } = input;
    this.checkDates(rest);
    const row = await orConflict('package_slug_taken', 'This edition already has a package with that slug', () =>
      this.prisma.$transaction(async (tx) => {
        const edition = await tx.raceEdition.findFirst({ where: { id: editionId, race: { deletedAt: null } }, select: { id: true } });
        if (!edition) throw notFound('edition_not_found', 'Edition not found');
        const created = await tx.package.create({
          data: { ...rest, editionId, checkInDate: toDate(rest.checkInDate), checkOutDate: toDate(rest.checkOutDate), balanceDueDate: toDate(rest.balanceDueDate), saleStatus: 'draft', ...depositColumns(deposit) },
        });
        await this.audit.record(tx, { actor, action: 'catalogue.package.created', entityType: 'Package', entityId: created.id, reason, after: view(created) });
        return created;
      }),
    );
    return this.get(row.id);
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updatePackageSchema>) {
    const { version, reason, deposit, ...rest } = input;
    await orConflict('package_slug_taken', 'This edition already has a package with that slug', () =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.package.findFirst({ where: { id, deletedAt: null, edition: { race: { deletedAt: null } } } });
        assertVersion(before, version, 'Package not found');
        this.checkDates({
          checkInDate: rest.checkInDate ?? fromDate(before.checkInDate)!,
          checkOutDate: rest.checkOutDate ?? fromDate(before.checkOutDate)!,
          balanceDueDate: rest.balanceDueDate ?? fromDate(before.balanceDueDate)!,
          minTravellers: rest.minTravellers ?? before.minTravellers,
          maxTravellers: rest.maxTravellers ?? before.maxTravellers,
        });
        if (deposit === null && LIVE_SALE_STATUSES.includes(before.saleStatus as SaleStatus)) throw conflict('open_package_needs_deposit', 'A package on sale needs its deposit');
        const data: Prisma.PackageUpdateManyMutationInput = {
          ...defined({ ...rest, checkInDate: undefined, checkOutDate: undefined, balanceDueDate: undefined }),
          ...(rest.checkInDate ? { checkInDate: toDate(rest.checkInDate) } : {}),
          ...(rest.checkOutDate ? { checkOutDate: toDate(rest.checkOutDate) } : {}),
          ...(rest.balanceDueDate ? { balanceDueDate: toDate(rest.balanceDueDate) } : {}),
          ...(deposit === undefined ? {} : depositColumns(deposit)),
          version: { increment: 1 },
        };
        const res = await tx.package.updateMany({ where: { id, version }, data });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.package.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'catalogue.package.updated', entityType: 'Package', entityId: id, reason, before: view(before), after: view(after) });
      }),
    );
    return this.get(id);
  }

  /**
   * Sale status by the table in transitions.ts (plan 6.1), as a compare-and-set in one transaction with its audit entry
   * and its event. Demo packages never leave draft; `open` needs a deposit and every registered gate.
   */
  async setSaleStatus(actor: Actor, id: string, input: { status: SaleStatus; version: number; reason?: string }) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.package.findFirst({ where: { id, deletedAt: null, edition: { race: { deletedAt: null } } }, include: { edition: { select: { raceId: true, race: { select: { isDemo: true } } } } } });
      assertVersion(before, input.version, 'Package not found');
      const from = before.saleStatus as SaleStatus;
      if (!canMove(SALE_TRANSITIONS, from, input.status)) throw conflict('transition_not_allowed', 'This status change is not allowed');
      if (input.status !== 'draft' && before.edition.race.isDemo) throw conflict('demo_cannot_be_published', 'Demo data cannot be published');
      if (input.status === 'open') {
        if (before.depositMode === null) throw conflict('deposit_not_configured', 'Set the deposit before opening the package');
        const failed = await this.gates.firstFailure(tx, { id, editionId: before.editionId, currency: before.currency });
        if (failed) throw conflict(failed.code, failed.message);
      }
      const res = await tx.package.updateMany({
        where: { id, version: input.version, saleStatus: from },
        data: { saleStatus: input.status, version: { increment: 1 }, ...(from === 'draft' ? { publishedAt: new Date() } : {}) },
      });
      if (res.count !== 1) throw versionConflict();
      await this.audit.record(tx, { actor, action: 'catalogue.package.sale_status_changed', entityType: 'Package', entityId: id, reason: input.reason, before: { saleStatus: from }, after: { saleStatus: input.status } });
      await this.outbox.publish(tx, {
        type: 'catalogue.package.sale_status_changed', aggregateType: 'Package', aggregateId: id, aggregateVersion: input.version + 1,
        payload: { packageId: id, editionId: before.editionId, raceId: before.edition.raceId, fromStatus: from, toStatus: input.status },
        actorType: actor.type, actorId: actor.id,
      });
    });
    return this.get(id);
  }

  /** Soft delete of a draft package. */
  async remove(actor: Actor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.package.findFirst({ where: { id, deletedAt: null, edition: { race: { deletedAt: null } } } });
      if (!p) throw notFound('package_not_found', 'Package not found');
      if (p.saleStatus !== 'draft') throw conflict('package_not_draft', 'Only a draft package can be deleted');
      const res = await tx.package.updateMany({ where: { id, saleStatus: 'draft', deletedAt: null }, data: { deletedAt: new Date(), deletedById: actor.id, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      await this.audit.record(tx, { actor, action: 'catalogue.package.deleted', entityType: 'Package', entityId: id, reason, before: { deletedAt: null }, after: { deletedAt: new Date() } });
    });
  }

  private async livePackage(tx: Tx, id: string) {
    const p = await tx.package.findFirst({ where: { id, deletedAt: null, edition: { race: { deletedAt: null } } }, include: { edition: { select: { raceId: true, race: { select: { isDemo: true } } } } } });
    if (!p) throw notFound('package_not_found', 'Package not found');
    return p;
  }

  private async poolFor(tx: Tx, poolId: string, kind: 'entry' | 'room' | 'extra', editionId: string) {
    const pool = await tx.inventoryPool.findUnique({ where: { id: poolId }, select: { id: true, kind: true, editionId: true } });
    if (!pool) throw notFound('pool_not_found', 'Stock pool not found');
    if (pool.kind !== kind) throw unprocessable('pool_wrong_kind', `This needs a ${kind} stock pool`);
    if (pool.editionId !== editionId) throw unprocessable('pool_other_edition', 'The stock pool belongs to another edition');
    return pool;
  }

  // ---- Participation and entries ----

  async setParticipation(actor: Actor, packageId: string, input: z.infer<typeof setParticipationSchema>) {
    await this.prisma.$transaction(async (tx) => {
      await this.livePackage(tx, packageId);
      const existing = await tx.packageParticipationOption.findMany({ where: { packageId }, select: { type: true } });
      const before = existing.map((e) => e.type).sort();
      await tx.packageParticipationOption.deleteMany({ where: { packageId } });
      if (input.types.length > 0) await tx.packageParticipationOption.createMany({ data: input.types.map((type) => ({ packageId, type, enabled: true })) });
      await this.audit.record(tx, {
        actor, action: 'catalogue.package.participation_changed', entityType: 'Package', entityId: packageId,
        before: { participationTypes: before }, after: { participationTypes: [...input.types].sort() }, fieldClasses: { participationTypes: 'nopii' },
      });
    });
    return this.get(packageId);
  }

  async addEntryOption(actor: Actor, packageId: string, input: z.infer<typeof entryOptionSchema>) {
    await orConflict('entry_option_exists', 'This package already has entries for that distance', () =>
      this.prisma.$transaction(async (tx) => {
        const pkg = await this.livePackage(tx, packageId);
        const distance = await tx.raceDistance.findUnique({ where: { id: input.raceDistanceId }, select: { raceId: true } });
        if (!distance) throw notFound('distance_not_found', 'Distance not found');
        if (distance.raceId !== pkg.edition.raceId) throw unprocessable('distance_other_race', 'The distance belongs to another race');
        await this.poolFor(tx, input.entryPoolId, 'entry', pkg.editionId);
        const row = await tx.packageEntryOption.create({ data: { packageId, ...input } });
        await this.audit.record(tx, { actor, action: 'catalogue.entry_option.created', entityType: 'PackageEntryOption', entityId: row.id, after: view(row) });
      }),
    );
    return this.get(packageId);
  }

  async removeEntryOption(actor: Actor, packageId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.livePackage(tx, packageId);
      const row = await tx.packageEntryOption.findFirst({ where: { id, packageId } });
      if (!row) throw notFound('entry_option_not_found', 'Entry option not found');
      await tx.packageEntryOption.delete({ where: { id } });
      await this.audit.record(tx, { actor, action: 'catalogue.entry_option.deleted', entityType: 'PackageEntryOption', entityId: id, before: view(row) });
    });
    return this.get(packageId);
  }

  // ---- Hotels linked to a package, and their rooms ----

  async addHotel(actor: Actor, packageId: string, input: z.infer<typeof addPackageHotelSchema>) {
    await orConflict('hotel_already_linked', 'This hotel is already part of the package', () =>
      this.prisma.$transaction(async (tx) => {
        const pkg = await this.livePackage(tx, packageId);
        const hotel = await tx.hotel.findFirst({ where: { id: input.hotelId, deletedAt: null } });
        if (!hotel) throw notFound('hotel_not_found', 'Hotel not found');
        if (hotel.isDemo !== pkg.edition.race.isDemo) throw conflict('demo_mismatch', 'Demo hotels go with demo races only');
        const row = await tx.packageHotel.create({ data: { packageId, hotelId: input.hotelId, displayOrder: input.displayOrder } });
        await this.audit.record(tx, { actor, action: 'catalogue.package_hotel.created', entityType: 'PackageHotel', entityId: row.id, after: view(row) });
      }),
    );
    return this.get(packageId);
  }

  async removeHotel(actor: Actor, packageId: string, packageHotelId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.livePackage(tx, packageId);
      const row = await tx.packageHotel.findFirst({ where: { id: packageHotelId, packageId }, include: { _count: { select: { rooms: true } } } });
      if (!row) throw notFound('package_hotel_not_found', 'Hotel is not part of this package');
      if (row._count.rooms > 0) throw conflict('hotel_has_rooms', 'Remove the rooms first');
      const { _count, ...plain } = row;
      await tx.packageHotel.delete({ where: { id: packageHotelId } });
      await this.audit.record(tx, { actor, action: 'catalogue.package_hotel.deleted', entityType: 'PackageHotel', entityId: packageHotelId, before: view(plain) });
    });
    return this.get(packageId);
  }

  async addRoom(actor: Actor, packageId: string, packageHotelId: string, input: z.infer<typeof roomOptionSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.livePackage(tx, packageId);
      const link = await tx.packageHotel.findFirst({ where: { id: packageHotelId, packageId }, select: { id: true } });
      if (!link) throw notFound('package_hotel_not_found', 'Hotel is not part of this package');
      await this.poolFor(tx, input.roomPoolId, 'room', pkg.editionId);
      const row = await tx.roomOption.create({ data: { ...input, packageHotelId } });
      await this.audit.record(tx, { actor, action: 'catalogue.room.created', entityType: 'RoomOption', entityId: row.id, after: view(row) });
    });
    return this.get(packageId);
  }

  async updateRoom(actor: Actor, packageId: string, roomId: string, input: z.infer<typeof updateRoomOptionSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.livePackage(tx, packageId);
      const before = await tx.roomOption.findFirst({ where: { id: roomId, packageHotel: { packageId } } });
      if (!before) throw notFound('room_not_found', 'Room not found');
      const min = input.minOccupancy ?? before.minOccupancy;
      const max = input.maxOccupancy ?? before.maxOccupancy;
      if (min > max) throw unprocessable('occupancy_invalid', 'The minimum occupancy cannot exceed the maximum');
      if (input.roomPoolId) await this.poolFor(tx, input.roomPoolId, 'room', pkg.editionId);
      const after = await tx.roomOption.update({ where: { id: roomId }, data: defined(input) });
      await this.audit.record(tx, { actor, action: 'catalogue.room.updated', entityType: 'RoomOption', entityId: roomId, before: view(before), after: view(after) });
    });
    return this.get(packageId);
  }

  async removeRoom(actor: Actor, packageId: string, roomId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.livePackage(tx, packageId);
      const before = await tx.roomOption.findFirst({ where: { id: roomId, packageHotel: { packageId } } });
      if (!before) throw notFound('room_not_found', 'Room not found');
      await tx.roomOption.delete({ where: { id: roomId } });
      await this.audit.record(tx, { actor, action: 'catalogue.room.deleted', entityType: 'RoomOption', entityId: roomId, before: view(before) });
    });
    return this.get(packageId);
  }

  // ---- Extras ----

  async addExtra(actor: Actor, packageId: string, input: z.infer<typeof createExtraSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.livePackage(tx, packageId);
      if (input.poolId) await this.poolFor(tx, input.poolId, 'extra', pkg.editionId);
      const { schedule, ...rest } = input;
      const row = await tx.extra.create({ data: { ...rest, packageId, schedule: schedule ?? undefined } });
      await this.audit.record(tx, { actor, action: 'catalogue.extra.created', entityType: 'Extra', entityId: row.id, after: view(row) });
    });
    return this.get(packageId);
  }

  async updateExtra(actor: Actor, packageId: string, extraId: string, input: z.infer<typeof updateExtraSchema>) {
    const { version, schedule, ...rest } = input;
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.livePackage(tx, packageId);
      const before = await tx.extra.findFirst({ where: { id: extraId, packageId, deletedAt: null } });
      assertVersion(before, version, 'Extra not found');
      if (rest.poolId) await this.poolFor(tx, rest.poolId, 'extra', pkg.editionId);
      const res = await tx.extra.updateMany({
        where: { id: extraId, version },
        data: { ...defined(rest), ...(schedule === undefined ? {} : { schedule: schedule === null ? Prisma.DbNull : schedule }), version: { increment: 1 } },
      });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.extra.findUniqueOrThrow({ where: { id: extraId } });
      await this.audit.record(tx, { actor, action: 'catalogue.extra.updated', entityType: 'Extra', entityId: extraId, before: view(before), after: view(after) });
    });
    return this.get(packageId);
  }

  async removeExtra(actor: Actor, packageId: string, extraId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.livePackage(tx, packageId);
      const res = await tx.extra.updateMany({ where: { id: extraId, packageId, deletedAt: null }, data: { deletedAt: new Date(), deletedById: actor.id, version: { increment: 1 } } });
      if (res.count !== 1) throw notFound('extra_not_found', 'Extra not found');
      await this.audit.record(tx, { actor, action: 'catalogue.extra.deleted', entityType: 'Extra', entityId: extraId, before: { deletedAt: null }, after: { deletedAt: new Date() } });
    });
    return this.get(packageId);
  }

  // ---- Hotels ----

  async listHotels() {
    return view(await this.prisma.hotel.findMany({ where: { deletedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 500 }));
  }

  async createHotel(actor: Actor, input: z.infer<typeof createHotelSchema>) {
    return view(
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.hotel.create({ data: { ...input, isDemo: false } });
        await this.audit.record(tx, { actor, action: 'catalogue.hotel.created', entityType: 'Hotel', entityId: row.id, after: view(row) });
        return row;
      }),
    );
  }

  async updateHotel(actor: Actor, id: string, input: z.infer<typeof updateHotelSchema>) {
    const { version, ...rest } = input;
    return view(
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.hotel.findFirst({ where: { id, deletedAt: null } });
        assertVersion(before, version, 'Hotel not found');
        const res = await tx.hotel.updateMany({ where: { id, version }, data: { ...defined(rest), version: { increment: 1 } } });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.hotel.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'catalogue.hotel.updated', entityType: 'Hotel', entityId: id, before: view(before), after: view(after) });
        return after;
      }),
    );
  }

  async deleteHotel(actor: Actor, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const hotel = await tx.hotel.findFirst({ where: { id, deletedAt: null } });
      if (!hotel) throw notFound('hotel_not_found', 'Hotel not found');
      const used = await tx.packageHotel.count({ where: { hotelId: id, package: { deletedAt: null } } });
      if (used > 0) throw conflict('hotel_in_use', 'The hotel is part of a package');
      await tx.hotel.update({ where: { id }, data: { deletedAt: new Date(), deletedById: actor.id, version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'catalogue.hotel.deleted', entityType: 'Hotel', entityId: id, before: { deletedAt: null }, after: { deletedAt: new Date() } });
    });
  }
}
