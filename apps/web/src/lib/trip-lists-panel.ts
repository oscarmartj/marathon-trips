import type { ListedTraveller, TripListKind, TripSummary } from '@mt/shared';

// Helpers for the trip lists panel (task 7.1). Display only: every name, date and count comes from the API.

export type { Itinerary, RoomingList, TransferList, TripSummary } from '@mt/shared';

/** The trip as one short line, such as "Polar Circle Marathon 2026 · Race weekend". */
export const tripLabel = (t: Pick<TripSummary, 'raceName' | 'year' | 'packageName'>): string => `${t.raceName} ${t.year} · ${t.packageName}`;

/** The API path of one list, as JSON or as a CSV download. */
export const listPath = (packageId: string, kind: TripListKind, format: 'json' | 'csv' = 'json'): string =>
  `/admin/trip-ops/trips/${encodeURIComponent(packageId)}/${kind}${format === 'csv' ? '?format=csv' : ''}`;

/** The name of a traveller as the API holds it. Null means the customer has not typed it yet; `[redacted]` is shown as stored. */
export const guestName = (g: Pick<ListedTraveller, 'givenName' | 'familyName'>, pending: string): string => (g.givenName === null ? pending : `${g.givenName} ${g.familyName ?? ''}`.trim());
