// Changes to a booking after its deposit (task 6.3). The browser only describes the new configuration: which places stay,
// which are new, nights and extras. It never computes or sends a price; totals, the difference and what is owed are the
// API's preview, shown as sent.
import { customerAmendmentPreviewSchema, staffAmendmentPreviewSchema } from '@mt/shared';
import type { CustomerAmendmentPreview, StaffAmendmentPreview } from '@mt/shared';

export type Participation = 'runner_with_entry' | 'runner_own_entry' | 'supporter';

/** A place as the current snapshot has it (place numbers are the booking's). */
export interface ConfigurationView {
  rooms: Array<{ roomOptionId: string; occupancy: number; travellers: Array<{ slot: number; participationType: Participation; raceDistanceId: string | null }> }>;
  extraNightsBefore: number;
  extraNightsAfter: number;
  extras: Array<{ extraId: string; travellerSlots: number[]; quantity: number }>;
}

export type FormTraveller =
  | { kind: 'keep'; slot: number; participationType: Participation; raceDistanceId: string | null }
  | { kind: 'new'; participationType: Participation; raceDistanceId: string | null; replacesSlot: number | null };

export interface StaffForm {
  expectedSnapshotVersion: number;
  rooms: Array<{ roomOptionId: string; travellers: FormTraveller[] }>;
  extraNightsBefore: number;
  extraNightsAfter: number;
  /** Per-person extras: the places (current place numbers, or `new:<room>:<index>`) that take each one. */
  perPerson: Record<string, string[]>;
  /** Per-booking extras: how many. */
  perBooking: Record<string, number>;
  reasonCode: StaffAmendmentPreview['reasonCode'];
}

/** A stable key for a traveller of the form: its place number, or its position among the new ones of its room. */
export const travellerKey = (form: StaffForm, room: number, index: number): string => {
  const x = form.rooms[room]!.travellers[index]!;
  return x.kind === 'keep' ? `slot:${x.slot}` : `new:${room}:${index}`;
};

/** The form for "change nothing yet": every place kept where it is, nights and extras as they are. */
export function formFrom(conf: ConfigurationView, version: number, perPersonExtraIds: ReadonlySet<string>): StaffForm {
  const perPerson: Record<string, string[]> = {};
  const perBooking: Record<string, number> = {};
  for (const e of conf.extras) {
    if (perPersonExtraIds.has(e.extraId)) perPerson[e.extraId] = e.travellerSlots.map((s) => `slot:${s}`);
    else perBooking[e.extraId] = e.quantity;
  }
  return {
    expectedSnapshotVersion: version,
    rooms: conf.rooms.map((r) => ({ roomOptionId: r.roomOptionId, travellers: r.travellers.map((x) => ({ kind: 'keep' as const, slot: x.slot, participationType: x.participationType, raceDistanceId: x.raceDistanceId })) })),
    extraNightsBefore: conf.extraNightsBefore,
    extraNightsAfter: conf.extraNightsAfter,
    perPerson,
    perBooking,
    reasonCode: 'customer_request',
  };
}

/**
 * The staff request body: positions for per-person extras are the travellers' order in the new rooms (as in a quote).
 * Checked against the shared strict schema, so it can never carry an amount.
 */
export function staffBody(form: StaffForm): StaffAmendmentPreview {
  const position = new Map<string, number>();
  let p = 0;
  form.rooms.forEach((r, ri) => r.travellers.forEach((_x, ti) => position.set(travellerKey(form, ri, ti), ++p)));
  const extras = [
    ...Object.entries(form.perPerson).flatMap(([extraId, keys]) => {
      const slots = keys.map((k) => position.get(k)).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
      return slots.length > 0 ? [{ extraId, travellerSlots: slots }] : [];
    }),
    ...Object.entries(form.perBooking).filter(([, q]) => q > 0).map(([extraId, quantity]) => ({ extraId, quantity })),
  ];
  return staffAmendmentPreviewSchema.parse({
    expectedSnapshotVersion: form.expectedSnapshotVersion,
    rooms: form.rooms.filter((r) => r.travellers.length > 0).map((r) => ({
      roomOptionId: r.roomOptionId,
      travellers: r.travellers.map((x) => (x.kind === 'keep' ? { keepSlot: x.slot } : {
        participationType: x.participationType,
        ...(x.participationType === 'runner_with_entry' && x.raceDistanceId ? { raceDistanceId: x.raceDistanceId } : {}),
        ...(x.replacesSlot !== null ? { replacesSlot: x.replacesSlot } : {}),
      })),
    })),
    extraNightsBefore: form.extraNightsBefore,
    extraNightsAfter: form.extraNightsAfter,
    extras,
    reasonCode: form.reasonCode,
  });
}

/** The customer's request body: nights and the optional extras they want, with the booking's place numbers. */
export function customerBody(input: { version: number; extraNightsBefore: number; extraNightsAfter: number; perPerson: Record<string, number[]>; perBooking: Record<string, number> }): CustomerAmendmentPreview {
  return customerAmendmentPreviewSchema.parse({
    expectedSnapshotVersion: input.version,
    extraNightsBefore: input.extraNightsBefore,
    extraNightsAfter: input.extraNightsAfter,
    extras: [
      ...Object.entries(input.perPerson).filter(([, s]) => s.length > 0).map(([extraId, s]) => ({ extraId, travellerSlots: [...s].sort((a, b) => a - b) })),
      ...Object.entries(input.perBooking).filter(([, q]) => q > 0).map(([extraId, quantity]) => ({ extraId, quantity })),
    ],
  });
}

/** What the API answers to a preview (amounts as strings of digits, signed where they can be negative). */
export interface AmendmentPreview {
  fromVersion: number;
  changes: string[];
  previousTotalMinor: string;
  newTotalMinor: string;
  priceDifferenceMinor: string;
  collectedMinor: string;
  outstandingAfterMinor: string;
  creditPendingAfterMinor: string;
  basisDriftMinor: string;
  currency: string;
  departureDate: string;
  returnDate: string;
  previewDigest: string;
  price: { lines: Array<{ key: string; kind: string; direction: string; travellerSlot: number | null; amountMinor: string }>; totalMinor: string; promo: { status: string } };
}

const KNOWN_ERRORS = new Set([
  'amendment_not_allowed', 'amendment_too_late', 'amendment_needs_staff', 'amendment_price_changed', 'amendment_price_basis_drifted', 'amendment_price_basis_unavailable',
  'amendment_blocked_by_payment', 'amendment_has_no_change', 'amendments_unavailable', 'version_conflict', 'inventory_unavailable', 'lead_place_required', 'place_unknown',
  'place_listed_twice', 'place_missing', 'amendment_limit_reached', 'terms_not_accepted',
]);

/** The message key for an error code of the change routes; anything else reads as a generic failure. */
export const amendmentErrorKey = (code: string | undefined): string => `amendments.errors.${code && KNOWN_ERRORS.has(code) ? code : 'generic'}`;

/** A signed amount of minor units as the API sent it, split into its sign and its absolute digits (no arithmetic). */
export function signOf(amount: string): { negative: boolean; abs: string } {
  return amount.startsWith('-') ? { negative: true, abs: amount.slice(1) } : { negative: false, abs: amount };
}
