import { enAU } from '@/lib/catalogue-panel';
import { t } from '@/lib/i18n';
import type { MissingJson } from '@/lib/pricing-panel';
import type { PricedPackage } from './pricing-types';

/** Names for the things a price can point at, from the package, so the screens never show a bare id. */
export interface Names {
  room: (id: string) => string;
  hotelOf: (roomId: string) => string;
  distance: (id: string | null) => string;
  extra: (id: string) => string;
  extraUnit: (id: string) => string | undefined;
  participation: (type: string, distanceId: string | null) => string;
}

export function namesOf(pkg: PricedPackage): Names {
  const rooms = new Map(pkg.hotels.flatMap((h) => h.rooms.map((r) => [r.id, { name: enAU(r.name) || t('admin.pricing.names.room'), hotel: h.hotel.name }] as const)));
  const distances = new Map(pkg.entryOptions.map((e) => [e.raceDistance.id, enAU(e.raceDistance.name) || t('admin.pricing.names.distance')] as const));
  const extras = new Map(pkg.extras.map((e) => [e.id, e] as const));
  return {
    room: (id) => rooms.get(id)?.name ?? t('admin.pricing.names.room'),
    hotelOf: (id) => rooms.get(id)?.hotel ?? '',
    distance: (id) => (id === null ? '' : distances.get(id) ?? t('admin.pricing.names.distance')),
    extra: (id) => enAU(extras.get(id)?.name) || t('admin.pricing.names.extra'),
    extraUnit: (id) => extras.get(id)?.pricingUnit,
    participation: (type, distanceId) => {
      const base = t(`admin.catalogue.participation.${type}`);
      return distanceId === null ? base : `${base}: ${distances.get(distanceId) ?? t('admin.pricing.names.distance')}`;
    },
  };
}

/** What a missing-rate report means, in words. */
export function describeMissing(m: MissingJson, names: Names): string {
  if (m.kind === 'room') return t('admin.pricing.missing.room', { room: names.room(m.roomOptionId!), count: m.occupancy! });
  if (m.kind === 'extra_night') return t('admin.pricing.missing.extraNight', { room: names.room(m.roomOptionId!), count: m.occupancy! });
  if (m.kind === 'participation') return t('admin.pricing.missing.participation', { what: names.participation(m.participationType!, m.raceDistanceId ?? null) });
  return t('admin.pricing.missing.extra', { extra: names.extra(m.extraId!) });
}
