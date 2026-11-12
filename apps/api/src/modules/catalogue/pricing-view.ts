import { Injectable } from '@nestjs/common';
import type { SaleStatus } from '@mt/shared';
import { fromDate } from './support';
import type { Tx } from './support';
import { PUBLIC_SALE_STATUSES } from './transitions';

/** What pricing needs to know about a package (plan 2.1, section 9). Read-only; amounts are bigint. */
export interface PackagePricingView {
  packageId: string;
  editionId: string;
  raceId: string;
  currency: string;
  saleStatus: SaleStatus;
  /** The public website may show it: race published and not demo, edition not draft, package not draft (plan 6.1). */
  publiclyVisible: boolean;
  checkInDate: string;
  checkOutDate: string;
  balanceDueDate: string;
  minTravellers: number;
  maxTravellers: number;
  maxExtraNightsBefore: number;
  maxExtraNightsAfter: number;
  deposit: { mode: 'per_person' | 'per_booking'; amountMinor: bigint } | { mode: 'percent'; bps: number } | null;
  rooms: Array<{ id: string; minOccupancy: number; maxOccupancy: number }>;
  participationTypes: Array<'runner_with_entry' | 'runner_own_entry' | 'supporter'>;
  entryDistanceIds: string[];
  /** Every distance of the race, offered or not (a rate may price one before it is offered). */
  raceDistanceIds: string[];
  extras: Array<{ id: string; pricingUnit: 'per_person' | 'per_booking'; availableTo: 'all' | 'runners' | 'supporters'; mandatory: boolean; maxPerBooking: number | null }>;
}

/** The catalogue's read-only door for pricing, so pricing never reads catalogue tables itself (plan 3.1). */
@Injectable()
export class PackagePricingReader {
  /** The package as it is inside `tx`, or null if it does not exist or is deleted. */
  async load(tx: Tx, packageId: string): Promise<PackagePricingView | null> {
    const p = await tx.package.findFirst({
      where: { id: packageId, deletedAt: null, edition: { race: { deletedAt: null } } },
      include: {
        edition: { select: { id: true, status: true, raceId: true, race: { select: { status: true, isDemo: true, distances: { select: { id: true }, orderBy: { id: 'asc' } } } } } },
        participationOptions: { where: { enabled: true }, orderBy: { type: 'asc' } },
        entryOptions: { orderBy: { raceDistanceId: 'asc' } },
        hotels: { include: { rooms: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } },
        extras: { where: { deletedAt: null }, orderBy: { id: 'asc' } },
      },
    });
    if (!p) return null;
    const deposit: PackagePricingView['deposit'] =
      p.depositMode === null ? null
        : p.depositMode === 'percent' ? { mode: 'percent', bps: p.depositBps! }
          : { mode: p.depositMode, amountMinor: p.depositAmountMinor! };
    return {
      packageId: p.id,
      editionId: p.editionId,
      raceId: p.edition.raceId,
      currency: p.currency,
      saleStatus: p.saleStatus as SaleStatus,
      publiclyVisible: p.edition.race.status === 'published' && !p.edition.race.isDemo && p.edition.status !== 'draft' && PUBLIC_SALE_STATUSES.includes(p.saleStatus as SaleStatus),
      checkInDate: fromDate(p.checkInDate)!,
      checkOutDate: fromDate(p.checkOutDate)!,
      balanceDueDate: fromDate(p.balanceDueDate)!,
      minTravellers: p.minTravellers,
      maxTravellers: p.maxTravellers,
      maxExtraNightsBefore: p.maxExtraNightsBefore,
      maxExtraNightsAfter: p.maxExtraNightsAfter,
      deposit,
      rooms: p.hotels.flatMap((h) => h.rooms.map((r) => ({ id: r.id, minOccupancy: r.minOccupancy, maxOccupancy: r.maxOccupancy }))),
      participationTypes: p.participationOptions.map((o) => o.type),
      entryDistanceIds: p.entryOptions.map((e) => e.raceDistanceId),
      raceDistanceIds: p.edition.race.distances.map((d) => d.id),
      extras: p.extras.map((e) => ({ id: e.id, pricingUnit: e.pricingUnit, availableTo: e.availableTo, mandatory: e.mandatory, maxPerBooking: e.maxPerBooking })),
    };
  }
}
