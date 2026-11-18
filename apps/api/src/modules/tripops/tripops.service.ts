import { Inject, Injectable } from '@nestjs/common';
import { TRIP_LIST_BOOKING_STATUSES } from '@mt/shared';
import type { Itinerary, RoomingList, TransferList, TripListKind, TripSummary } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { notFound } from '../../platform/http/api-error';
import { activeTravellers, buildItinerary, buildRoomingList, buildTransferList, isoDay, itineraryCsv, localText, roomingCsv, transfersCsv } from './lists';

type Tx = Prisma.TransactionClient;
type Actor = AuditActor & { id: string };
export type ListFormat = 'json' | 'csv';
export interface ListResult<T> { data: T; csv: string | null; filename: string }

const STATUSES = [...TRIP_LIST_BOOKING_STATUSES];
/** Letters, digits and hyphens only, so a slug typed in the catalogue can never shape a header. */
const safe = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'trip';

/**
 * The trip lists (task 7.1). Read-only: every query is a plain read of bookings, traveller names and catalogue data, and
 * the only write is the audit entry. Traveller rows are selected column by column: date of birth, emergency contact and
 * estimated finish time are never read, and no customer contact or payment data is read at all.
 */
@Injectable()
export class TripOpsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async summary(tx: Tx, packageId: string): Promise<{ trip: TripSummary; slugs: string }> {
    const p = await tx.package.findFirst({
      where: { id: packageId, deletedAt: null, edition: { race: { deletedAt: null } } },
      select: { id: true, slug: true, name: true, checkInDate: true, checkOutDate: true, edition: { select: { year: true, race: { select: { slug: true, name: true } } } } },
    });
    if (!p) throw notFound('trip_not_found', 'Trip not found');
    const bookings = await tx.booking.count({ where: { packageId, status: { in: STATUSES } } });
    return {
      trip: { packageId: p.id, raceName: localText(p.edition.race.name), year: p.edition.year, packageName: localText(p.name), checkInDate: isoDay(p.checkInDate), checkOutDate: isoDay(p.checkOutDate), bookings },
      slugs: safe(`${p.edition.race.slug}-${p.edition.year}-${p.slug}`),
    };
  }

  /** Trips to choose from: every package of a live race, with how many bookings are on the lists. */
  async trips(): Promise<{ items: TripSummary[] }> {
    return this.prisma.$transaction(async (tx) => {
      const packages = await tx.package.findMany({
        where: { deletedAt: null, edition: { race: { deletedAt: null } } },
        select: { id: true, name: true, checkInDate: true, checkOutDate: true, edition: { select: { year: true, race: { select: { name: true } } } } },
        orderBy: [{ checkInDate: 'desc' }, { id: 'asc' }],
        take: 500,
      });
      const counts = await tx.booking.groupBy({ by: ['packageId'], where: { packageId: { in: packages.map((p) => p.id) }, status: { in: STATUSES } }, _count: { _all: true } });
      const n = new Map(counts.map((c) => [c.packageId, c._count._all]));
      return {
        items: packages.map((p) => ({
          packageId: p.id, raceName: localText(p.edition.race.name), year: p.edition.year, packageName: localText(p.name),
          checkInDate: isoDay(p.checkInDate), checkOutDate: isoDay(p.checkOutDate), bookings: n.get(p.id) ?? 0,
        })),
      };
    });
  }

  async roomingList(actor: Actor, packageId: string, format: ListFormat): Promise<ListResult<RoomingList>> {
    return this.prisma.$transaction(async (tx) => {
      const { trip, slugs } = await this.summary(tx, packageId);
      const rows = await tx.booking.findMany({
        where: { packageId, status: { in: STATUSES } },
        select: {
          reference: true, status: true, departureDate: true, returnDate: true,
          rooms: { select: { id: true, occupancy: true, travellerSlots: true, roomOption: { select: { roomType: true, name: true, packageHotel: { select: { displayOrder: true, hotel: { select: { id: true, name: true, city: true } } } } } } } },
          travellers: { select: { slot: true, isLead: true, removedInVersion: true } },
          travellerDetails: { select: { slot: true, givenName: true, familyName: true } },
        },
      });
      const data = buildRoomingList({
        trip,
        bookings: rows.map((b) => ({
          reference: b.reference, status: b.status, checkIn: b.departureDate, checkOut: b.returnDate,
          travellers: activeTravellers(b.travellers, b.travellerDetails),
          rooms: b.rooms.map((r) => ({ id: r.id, occupancy: r.occupancy, travellerSlots: r.travellerSlots, roomType: r.roomOption.roomType, roomName: r.roomOption.name, hotel: { ...r.roomOption.packageHotel.hotel, displayOrder: r.roomOption.packageHotel.displayOrder } })),
        })),
      });
      return this.finish(tx, actor, packageId, 'rooming-list', format, data, data.totals.rooms, () => roomingCsv(data), slugs);
    });
  }

  async transfers(actor: Actor, packageId: string, format: ListFormat): Promise<ListResult<TransferList>> {
    return this.prisma.$transaction(async (tx) => {
      const { trip, slugs } = await this.summary(tx, packageId);
      const extras = await tx.extra.findMany({
        where: { packageId, kind: 'transfer', bookingExtras: { some: { booking: { status: { in: STATUSES } } } } },
        select: {
          id: true, name: true, pricingUnit: true, schedule: true,
          bookingExtras: {
            where: { booking: { status: { in: STATUSES } } },
            select: {
              quantity: true, travellerSlot: true,
              booking: { select: { reference: true, departureDate: true, returnDate: true, travellers: { select: { slot: true, isLead: true, removedInVersion: true } }, travellerDetails: { select: { slot: true, givenName: true, familyName: true } } } },
            },
          },
        },
        orderBy: { id: 'asc' },
      });
      const data = buildTransferList({
        trip,
        extras: extras.map((e) => ({
          id: e.id, name: e.name, pricingUnit: e.pricingUnit, schedule: e.schedule,
          rows: e.bookingExtras.map((x) => ({ bookingReference: x.booking.reference, checkIn: x.booking.departureDate, checkOut: x.booking.returnDate, quantity: x.quantity, travellerSlot: x.travellerSlot, travellers: activeTravellers(x.booking.travellers, x.booking.travellerDetails) })),
        })),
      });
      return this.finish(tx, actor, packageId, 'transfers', format, data, data.totals.passengers, () => transfersCsv(data), slugs);
    });
  }

  async itinerary(actor: Actor, packageId: string, format: ListFormat): Promise<ListResult<Itinerary>> {
    return this.prisma.$transaction(async (tx) => {
      const { trip, slugs } = await this.summary(tx, packageId);
      const p = await tx.package.findUniqueOrThrow({
        where: { id: packageId },
        select: {
          edition: { select: { startDate: true, endDate: true, dateStatus: true, race: { select: { name: true } } } },
          hotels: { select: { displayOrder: true, hotel: { select: { name: true, deletedAt: true } } }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] },
          entryOptions: { select: { raceDistance: { select: { name: true, distanceMetres: true } } } },
          extras: { where: { deletedAt: null }, select: { kind: true, name: true, schedule: true }, orderBy: { id: 'asc' } },
        },
      });
      const data = buildItinerary({
        trip, raceName: localText(p.edition.race.name), raceStart: p.edition.startDate, raceEnd: p.edition.endDate, raceDatesConfirmed: p.edition.dateStatus === 'confirmed',
        distances: p.entryOptions.map((o) => o.raceDistance).sort((a, b) => b.distanceMetres - a.distanceMetres).map((d) => localText(d.name)),
        hotels: p.hotels.filter((h) => !h.hotel.deletedAt).map((h) => h.hotel.name),
        extras: p.extras,
      });
      return this.finish(tx, actor, packageId, 'itinerary', format, data, data.days.length, () => itineraryCsv(data), slugs);
    });
  }

  /** Audits the read (ids, list and count only: never a name) and names the download. */
  private async finish<T>(tx: Tx, actor: Actor, packageId: string, kind: TripListKind, format: ListFormat, data: T, rows: number, csv: () => string, slugs: string): Promise<ListResult<T>> {
    await this.audit.record(tx, {
      actor, action: format === 'csv' ? 'tripops.list.exported' : 'tripops.list.viewed', entityType: 'Package', entityId: packageId,
      context: { list: kind, rows },
    });
    return { data, csv: format === 'csv' ? csv() : null, filename: `${kind}-${slugs}.csv` };
  }
}
