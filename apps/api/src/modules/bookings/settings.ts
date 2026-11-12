import { z } from 'zod';
import type { SettingsService } from '../../platform/flags/flags.service';

/** Business settings of the bookings module (plan 2.4, section 3), with conservative defaults (assumptions 1 to 4, 11). */
export const BOOKING_SETTINGS = {
  salesCountries: { key: 'salesCountries', fallback: ['AU'] as string[], schema: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250), description: 'Countries of residence that may send a booking request (residents of any other country join the waiting list instead, task 2.6)' },
  requestExpiryHours: { key: 'bookingRequestExpiryHours', fallback: 168, schema: z.number().int().min(24).max(720), description: 'Hours an unreviewed booking request holds its stock (never past the start of the departure day)' },
  approvalExpiryHours: { key: 'bookingApprovalExpiryHours', fallback: 72, schema: z.number().int().min(24).max(720), description: 'Hours an approved booking waits for its deposit (the sweep arrives with payments)' },
  maxOpenRequests: { key: 'maxOpenRequestsPerCustomer', fallback: 3, schema: z.number().int().min(1).max(20), description: 'Unreviewed booking requests one customer may have at once' },
  maxHeldPlaces: { key: 'maxHeldPlacesPerCustomer', fallback: 12, schema: z.number().int().min(1).max(200), description: 'Stock places (rooms, entries, extras) one customer may hold at once with unreviewed requests' },
} as const;

export function defineBookingSettings(settings: SettingsService): void {
  for (const s of Object.values(BOOKING_SETTINGS)) settings.define(s.key, s.schema, 1, { description: s.description });
}

export interface BookingLimits {
  salesCountries: string[];
  requestExpiryHours: number;
  approvalExpiryHours: number;
  maxOpenRequests: number;
  maxHeldPlaces: number;
}

export async function readBookingLimits(settings: SettingsService): Promise<BookingLimits> {
  const S = BOOKING_SETTINGS;
  return {
    salesCountries: await settings.get(S.salesCountries.key, S.salesCountries.fallback),
    requestExpiryHours: await settings.get(S.requestExpiryHours.key, S.requestExpiryHours.fallback),
    approvalExpiryHours: await settings.get(S.approvalExpiryHours.key, S.approvalExpiryHours.fallback),
    maxOpenRequests: await settings.get(S.maxOpenRequests.key, S.maxOpenRequests.fallback),
    maxHeldPlaces: await settings.get(S.maxHeldPlaces.key, S.maxHeldPlaces.fallback),
  };
}
