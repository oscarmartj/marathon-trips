import type { PackageForPrices } from '@/lib/pricing-panel';

/** The package as the catalogue API gives it, with the fields the pricing screens read. */
export interface PricedPackage extends PackageForPrices {
  id: string;
  editionId: string;
  slug: string;
  name: unknown;
  saleStatus: string;
  checkInDate: string;
  checkOutDate: string;
  entryOptions: Array<{ id: string; raceDistance: { id: string; name: unknown } }>;
  participationOptions: Array<{ type: string; enabled: boolean }>;
  hotels: Array<{ id: string; hotel: { id: string; name: string; city: string }; rooms: Array<{ id: string; name: unknown; roomType: string; minOccupancy: number; maxOccupancy: number }> }>;
  extras: Array<{ id: string; name: unknown; kind: string; pricingUnit: string; availableTo: string; mandatory: boolean; maxPerBooking: number | null }>;
  edition: { id: string; year: number; raceId: string };
}
