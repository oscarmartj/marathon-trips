import { z } from 'zod';

// Trip lists for operations (task 7.1): the rooming list, the transfers list and the day-by-day itinerary of one trip
// (a package of an edition). The first two hold travellers' names, so they are staff-only and built for one purpose each:
// no date of birth, no emergency contact, no contact details and no money. Strict objects: an unknown query key is a 422.

export const TRIP_LIST_KINDS = ['rooming-list', 'transfers', 'itinerary'] as const;
export type TripListKind = (typeof TRIP_LIST_KINDS)[number];

/** `json` is what the panel reads; `csv` is a download made on request. */
export const TRIP_LIST_FORMATS = ['json', 'csv'] as const;

export const tripListQuerySchema = z.strictObject({ format: z.enum(TRIP_LIST_FORMATS).default('json') });

/**
 * Bookings that appear on the rooming and transfers lists: the deposit is paid, so rooms and places are committed and
 * the traveller details are open (task 5.2). Requested, approved, declined, expired, cancelled and refunded ones never do.
 */
export const TRIP_LIST_BOOKING_STATUSES = ['deposit_paid', 'confirmed', 'balance_paid', 'completed'] as const;

export interface TripSummary {
  packageId: string;
  raceName: string;
  year: number;
  packageName: string;
  /** YYYY-MM-DD */
  checkInDate: string;
  checkOutDate: string;
  /** Bookings on the lists (see TRIP_LIST_BOOKING_STATUSES): a count, no names. */
  bookings: number;
}

/** A person in a room or on a transfer. Names are as stored: `[redacted]` once the customer was erased, null until typed. */
export interface ListedTraveller {
  slot: number;
  givenName: string | null;
  familyName: string | null;
  isLead: boolean;
}

export interface RoomingRoom {
  bookingReference: string;
  bookingStatus: string;
  roomType: string;
  roomName: string;
  occupancy: number;
  checkIn: string;
  checkOut: string;
  guests: ListedTraveller[];
}
export interface RoomingHotel {
  hotelId: string;
  hotelName: string;
  city: string;
  rooms: RoomingRoom[];
}
export interface RoomingList {
  trip: TripSummary;
  hotels: RoomingHotel[];
  totals: { rooms: number; guests: number; detailsPending: number };
}

export interface TransferBooking {
  bookingReference: string;
  quantity: number;
  checkIn: string;
  checkOut: string;
  passengers: ListedTraveller[];
}
export interface TransferGroup {
  extraId: string;
  name: string;
  /** Free text typed in the catalogue; null when none was typed. */
  departure: string | null;
  origin: string | null;
  destination: string | null;
  bookings: TransferBooking[];
  totalQuantity: number;
}
export interface TransferList {
  trip: TripSummary;
  transfers: TransferGroup[];
  totals: { passengers: number; detailsPending: number };
}

export interface ItineraryItem {
  kind: 'check_in' | 'check_out' | 'race' | 'extra';
  title: string;
  /** Hotel names, the schedule typed in the catalogue, or the distances; never personal data. */
  detail: string | null;
}
export interface ItineraryDay {
  date: string;
  /** 1 on the check-in day; null for a day outside the package's own nights. */
  dayNumber: number | null;
  items: ItineraryItem[];
}
export interface Itinerary {
  trip: TripSummary;
  days: ItineraryDay[];
  /** Excursions and transfers whose schedule is not a date, so they cannot be placed on a day. */
  unscheduled: ItineraryItem[];
  raceDatesProvisional: boolean;
}
