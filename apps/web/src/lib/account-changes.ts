// What the customer's change page needs from the booking and its package (task 6.3). No prices: only the choices.
import type { ChangeFormProps } from '@/components/account/change-form';
import type { AccountBookingDetail } from '@/components/account/booking-overview';
import type { PackageDetail } from './catalogue';
import { getPackage, localisedText } from './catalogue';

export function changeFormProps(view: AccountBookingDetail, pkg: Pick<PackageDetail, 'extras' | 'maxExtraNightsBefore' | 'maxExtraNightsAfter'>): ChangeFormProps | null {
  const conf = view.booking.price.configuration;
  if (!conf || view.booking.currentSnapshotVersion === undefined) return null;
  const extras = pkg.extras.filter((x) => !x.mandatory).map((x) => ({ id: x.id, name: localisedText(x.name), perPerson: x.pricingUnit === 'per_person', maxPerBooking: x.maxPerBooking ?? 1 }));
  const perPerson: Record<string, number[]> = {};
  const perBooking: Record<string, number> = {};
  for (const e of conf.extras) {
    const x = extras.find((y) => y.id === e.extraId);
    if (!x) continue;
    if (x.perPerson) perPerson[e.extraId] = [...e.travellerSlots];
    else perBooking[e.extraId] = e.quantity;
  }
  return {
    reference: view.booking.reference,
    version: view.booking.currentSnapshotVersion,
    places: conf.rooms.flatMap((r) => r.travellers.map((tr) => ({ slot: tr.slot }))),
    nights: { before: conf.extraNightsBefore, after: conf.extraNightsAfter, maxBefore: pkg.maxExtraNightsBefore, maxAfter: pkg.maxExtraNightsAfter },
    extras,
    current: { perPerson, perBooking },
  };
}

/** The booking's package from the public catalogue, when online changes are on; null otherwise or when it cannot be read. */
export async function packageFor(view: AccountBookingDetail): Promise<PackageDetail | null> {
  if (!view.changes?.customerChangesEnabled) return null;
  const p = view.booking.package;
  try {
    return await getPackage(p.race.slug ?? '', p.editionYear, p.slug ?? '');
  } catch {
    return null;
  }
}
