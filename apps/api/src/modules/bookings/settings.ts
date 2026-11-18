import { z } from 'zod';
import { ISO_COUNTRY_CODES } from '@mt/shared';
import type { SettingsService } from '../../platform/flags/flags.service';

/** Business settings of the bookings module (plan 2.4, section 3), with conservative defaults (assumptions 1 to 4, 11). */
export const BOOKING_SETTINGS = {
  salesCountries: { key: 'salesCountries', fallback: ['AU'] as string[], schema: z.array(z.string().refine((c) => ISO_COUNTRY_CODES.has(c), 'an assigned ISO 3166-1 alpha-2 code in capitals')).min(1).max(250), description: 'Countries of residence that may send a booking request (residents of any other country join the waiting list instead, task 2.6)' },
  requestExpiryHours: { key: 'bookingRequestExpiryHours', fallback: 168, schema: z.number().int().min(24).max(720), description: 'Hours an unreviewed booking request holds its stock (never past the start of the departure day)' },
  approvalExpiryHours: { key: 'bookingApprovalExpiryHours', fallback: 72, schema: z.number().int().min(24).max(720), description: 'Hours an approved booking waits for its deposit (the sweep arrives with payments)' },
  maxOpenRequests: { key: 'maxOpenRequestsPerCustomer', fallback: 3, schema: z.number().int().min(1).max(20), description: 'Unreviewed booking requests one customer may have at once' },
  maxHeldPlaces: { key: 'maxHeldPlacesPerCustomer', fallback: 12, schema: z.number().int().min(1).max(200), description: 'Stock places (rooms, entries, extras) one customer may hold at once with unreviewed requests' },
} as const;

/**
 * Changes to a booking after its deposit (task 6.3; plan docs/plans/6.3-booking-amendments.md, decision 6 and section 6).
 * Customers' own changes start switched off (plan review M2): Oscar turns them on once he has read the overdue rule.
 */
export const AMENDMENT_SETTINGS = {
  customerEnabled: { key: 'customerAmendmentsEnabled', fallback: false as boolean, schema: z.boolean(), financial: true, description: 'Customers may change the extra nights and extras of a booking after the deposit themselves (they can never lower the price)' },
  customerCutoffDays: { key: 'bookingAmendmentCustomerCutoffDays', fallback: 14, schema: z.number().int().min(0).max(365), description: 'Days before departure after which customers can no longer change a booking themselves' },
  paymentDays: { key: 'amendmentPaymentDays', fallback: 7, schema: z.number().int().min(1).max(60), financial: true, description: 'Days a customer has to pay what a change of a booking adds' },
} as const;

export interface AmendmentSettings {
  customerEnabled: boolean;
  customerCutoffDays: number;
  paymentDays: number;
}

/** Read before the transaction (a caller inside one must not read settings there). */
export async function readAmendmentSettings(settings: SettingsService): Promise<AmendmentSettings> {
  const S = AMENDMENT_SETTINGS;
  return {
    customerEnabled: await settings.get(S.customerEnabled.key, S.customerEnabled.fallback),
    customerCutoffDays: await settings.get(S.customerCutoffDays.key, S.customerCutoffDays.fallback),
    paymentDays: await settings.get(S.paymentDays.key, S.paymentDays.fallback),
  };
}

export function defineBookingSettings(settings: SettingsService): void {
  for (const s of Object.values(BOOKING_SETTINGS)) settings.define(s.key, s.schema, 1, { description: s.description });
  for (const s of Object.values(AMENDMENT_SETTINGS)) settings.define(s.key, s.schema, 1, { description: s.description, ...('financial' in s ? { financial: s.financial } : {}) });
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
