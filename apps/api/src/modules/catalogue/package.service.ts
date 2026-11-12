import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type {
  SaleStatus, addPackageHotelSchema, createExtraSchema, createHotelSchema, createPackageSchema, depositSchema, duplicatePackageSchema, entryOptionSchema, roomOptionSchema,
  setParticipationSchema, updateExtraSchema, updateHotelSchema, updatePackageSchema, updateRoomOptionSchema,
} from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor, AuditContext } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { CatalogueRemovalGuards, PackageOpenGates } from './open-gates';
import { LIVE_SALE_STATUSES, SALE_TRANSITIONS, canMove } from './transitions';
import { Tx, assertVersion, defined, fromDate, lockPackage, orConflict, orInUse, toDate, versionConflict, view } from './support';

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
    @Inject(CatalogueRemovalGuards) private readonly removalGuards: CatalogueRemovalGuards,
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
    const row = await orConflict('package_slug_taken', 'This edition already has a package with that slug', () => this.prisma.$transaction((tx) => this.createIn(tx, actor, editionId, input)));
    return this.get(row.id);
  }

  /** Creates a draft package in the caller's transaction (also used by the CSV import). */
  async createIn(tx: Tx, actor: Actor, editionId: string, input: z.infer<typeof createPackageSchema>, context?: AuditContext) {
    const { reason, deposit, ...rest } = input;
    this.checkDates(rest);
    const edition = await tx.raceEdition.findFirst({ where: { id: editionId, race: { deletedAt: null } }, select: { id: true } });
    if (!edition) throw notFound('edition_not_found', 'Edition not found');
    const created = await tx.package.create({
      data: { ...rest, editionId, checkInDate: toDate(rest.checkInDate), checkOutDate: toDate(rest.checkOutDate), balanceDueDate: toDate(rest.balanceDueDate), saleStatus: 'draft', ...depositColumns(deposit) },
    });
    await this.audit.record(tx, { actor, action: 'catalogue.package.created', entityType: 'Package', entityId: created.id, reason, after: view(created), context });
    return created;
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
      // Locked first, so a concurrent change to the options (FOR SHARE) or a publish cannot slip past the gates (2.1, G1).
      await lockPackage(tx, id, 'update');
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

  /**
   * Copies a package to another edition of the same race (task 1.2) as a draft. The dates and the slug come from the caller.
   * Stock pools are created again in the target edition, empty and unconfirmed (a supplier's confirmation is about one
   * edition, so it is never inherited); a pool the source shared between lines is shared in the copy too. All or nothing.
   */
  async duplicate(actor: Actor, sourceId: string, input: z.infer<typeof duplicatePackageSchema>) {
    const { reason, targetEditionId, slug, name, checkInDate, checkOutDate, balanceDueDate } = input;
    const created = await orConflict('package_slug_taken', 'The target edition already has a package with that slug', () =>
      this.prisma.$transaction(async (tx) => {
        const src = await tx.package.findFirst({
          where: { id: sourceId, deletedAt: null, edition: { race: { deletedAt: null } } },
          include: {
            edition: { select: { raceId: true } },
            participationOptions: true,
            entryOptions: { include: { entryPool: true } },
            hotels: { include: { rooms: { include: { roomPool: true } } } },
            extras: { where: { deletedAt: null }, include: { pool: true } },
          },
        });
        if (!src) throw notFound('package_not_found', 'Package not found');
        const target = await tx.raceEdition.findFirst({ where: { id: targetEditionId, race: { deletedAt: null } }, select: { id: true, raceId: true } });
        if (!target) throw notFound('edition_not_found', 'Edition not found');
        if (target.raceId !== src.edition.raceId) throw unprocessable('duplicate_other_race', 'A package can only be copied to another edition of the same race');
        this.checkDates({ checkInDate, checkOutDate, balanceDueDate, minTravellers: src.minTravellers, maxTravellers: src.maxTravellers });

        const pools = new Map<string, string>();
        const poolFor = async (pool: { id: string; kind: 'entry' | 'room' | 'extra'; label: string; capacity: number; lowStockThreshold: number | null }): Promise<string> => {
          const known = pools.get(pool.id);
          if (known) return known;
          const row = await tx.inventoryPool.create({
            data: { editionId: target.id, kind: pool.kind, label: pool.label, capacity: pool.capacity, lowStockThreshold: pool.lowStockThreshold, confirmedBySupplier: false, confirmationNote: null },
          });
          pools.set(pool.id, row.id);
          await this.audit.record(tx, { actor, action: 'catalogue.inventory.created', entityType: 'InventoryPool', entityId: row.id, after: view(row), context: { copiedFromPackage: sourceId } });
          return row.id;
        };

        const pkg = await tx.package.create({
          data: {
            editionId: target.id, slug, name: (name ?? src.name) as Prisma.InputJsonValue, saleStatus: 'draft',
            checkInDate: toDate(checkInDate), checkOutDate: toDate(checkOutDate), balanceDueDate: toDate(balanceDueDate),
            includes: src.includes as Prisma.InputJsonValue, excludes: src.excludes as Prisma.InputJsonValue,
            instantBooking: src.instantBooking, autoConfirmOnDeposit: src.autoConfirmOnDeposit,
            depositMode: src.depositMode, depositAmountMinor: src.depositAmountMinor, depositBps: src.depositBps,
            minTravellers: src.minTravellers, maxTravellers: src.maxTravellers, maxExtraNightsBefore: src.maxExtraNightsBefore, maxExtraNightsAfter: src.maxExtraNightsAfter,
            currency: src.currency, seo: src.seo as Prisma.InputJsonValue,
          },
        });
        if (src.participationOptions.length > 0) {
          await tx.packageParticipationOption.createMany({ data: src.participationOptions.map((o) => ({ packageId: pkg.id, type: o.type, enabled: o.enabled })) });
        }
        for (const o of src.entryOptions) {
          await tx.packageEntryOption.create({ data: { packageId: pkg.id, raceDistanceId: o.raceDistanceId, entryPoolId: await poolFor(o.entryPool) } });
        }
        for (const h of src.hotels) {
          const link = await tx.packageHotel.create({ data: { packageId: pkg.id, hotelId: h.hotelId, displayOrder: h.displayOrder } });
          for (const r of h.rooms) {
            await tx.roomOption.create({
              data: { packageHotelId: link.id, roomType: r.roomType, name: r.name as Prisma.InputJsonValue, minOccupancy: r.minOccupancy, maxOccupancy: r.maxOccupancy, roomPoolId: await poolFor(r.roomPool) },
            });
          }
        }
        for (const x of src.extras) {
          await tx.extra.create({
            data: {
              packageId: pkg.id, kind: x.kind, name: x.name as Prisma.InputJsonValue, description: x.description as Prisma.InputJsonValue, pricingUnit: x.pricingUnit, availableTo: x.availableTo,
              mandatory: x.mandatory, maxPerBooking: x.maxPerBooking, poolId: x.pool ? await poolFor(x.pool) : null, schedule: x.schedule === null ? undefined : (x.schedule as Prisma.InputJsonValue),
            },
          });
        }
        await this.audit.record(tx, { actor, action: 'catalogue.package.duplicated', entityType: 'Package', entityId: pkg.id, reason, after: view(pkg), context: { sourcePackage: sourceId } });
        return pkg;
      }),
    );
    return this.get(created.id);
  }

  /**
   * A package on sale must stay priceable (plan 2.1, G1): after a change to its options, the open gates run again in
   * the same transaction and a failure undoes the change with a 409.
   */
  private async recheckOnSale(tx: Tx, pkg: { id: string; editionId: string; currency: string; saleStatus: string }): Promise<void> {
    if (!LIVE_SALE_STATUSES.includes(pkg.saleStatus as SaleStatus)) return;
    const failed = await this.gates.firstFailure(tx, { id: pkg.id, editionId: pkg.editionId, currency: pkg.currency });
    if (failed) throw conflict(failed.code, failed.message);
  }

  private async refuseRemoval(tx: Tx, target: Parameters<CatalogueRemovalGuards['firstFailure']>[1]): Promise<void> {
    const failed = await this.removalGuards.firstFailure(tx, target);
    if (failed) throw conflict(failed.code, failed.message);
  }

  /** The package, locked FOR SHARE so its sale status cannot change until this change to its options commits. */
  private async livePackage(tx: Tx, id: string) {
    await lockPackage(tx, id, 'share');
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
      const pkg = await this.livePackage(tx, packageId);
      const existing = await tx.packageParticipationOption.findMany({ where: { packageId }, select: { type: true } });
      const before = existing.map((e) => e.type).sort();
      await tx.packageParticipationOption.deleteMany({ where: { packageId } });
      if (input.types.length > 0) await tx.packageParticipationOption.createMany({ data: input.types.map((type) => ({ packageId, type, enabled: true })) });
      await this.audit.record(tx, {
        actor, action: 'catalogue.package.participation_changed', entityType: 'Package', entityId: packageId,
        before: { participationTypes: before }, after: { participationTypes: [...input.types].sort() }, fieldClasses: { participationTypes: 'nopii' },
      });
      await this.recheckOnSale(tx, pkg);
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
        await this.recheckOnSale(tx, pkg);
      }),
    );
    return this.get(packageId);
  }

  async removeEntryOption(actor: Actor, packageId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.livePackage(tx, packageId);
      const row = await tx.packageEntryOption.findFirst({ where: { id, packageId } });
      if (!row) throw notFound('entry_option_not_found', 'Entry option not found');
      await this.refuseRemoval(tx, { kind: 'entry_option', packageId, raceDistanceId: row.raceDistanceId });
      await orInUse('entry_option_in_use', 'Something still uses this entry option', () => tx.packageEntryOption.delete({ where: { id } }));
      await this.audit.record(tx, { actor, action: 'catalogue.entry_option.deleted', entityType: 'PackageEntryOption', entityId: id, before: view(row) });
      await this.recheckOnSale(tx, pkg);
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
      await this.recheckOnSale(tx, pkg);
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
      await this.recheckOnSale(tx, pkg);
    });
    return this.get(packageId);
  }

  async removeRoom(actor: Actor, packageId: string, roomId: string) {
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.livePackage(tx, packageId);
      const before = await tx.roomOption.findFirst({ where: { id: roomId, packageHotel: { packageId } } });
      if (!before) throw notFound('room_not_found', 'Room not found');
      await this.refuseRemoval(tx, { kind: 'room', roomOptionId: roomId, packageId });
      await orInUse('room_in_use', 'Something still uses this room', () => tx.roomOption.delete({ where: { id: roomId } }));
      await this.audit.record(tx, { actor, action: 'catalogue.room.deleted', entityType: 'RoomOption', entityId: roomId, before: view(before) });
      await this.recheckOnSale(tx, pkg);
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
      await this.recheckOnSale(tx, pkg);
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
      await this.recheckOnSale(tx, pkg);
    });
    return this.get(packageId);
  }

  async removeExtra(actor: Actor, packageId: string, extraId: string) {
    await this.prisma.$transaction(async (tx) => {
      const pkg = await this.livePackage(tx, packageId);
      const res = await tx.extra.updateMany({ where: { id: extraId, packageId, deletedAt: null }, data: { deletedAt: new Date(), deletedById: actor.id, version: { increment: 1 } } });
      if (res.count !== 1) throw notFound('extra_not_found', 'Extra not found');
      await this.audit.record(tx, { actor, action: 'catalogue.extra.deleted', entityType: 'Extra', entityId: extraId, before: { deletedAt: null }, after: { deletedAt: new Date() } });
      await this.recheckOnSale(tx, pkg);
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
