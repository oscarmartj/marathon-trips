import type { DashboardSectionKey, DashboardView } from '@mt/shared';

// Helpers for the staff start page (task 5.6). Display only: every count, amount and date comes from the API, and nothing
// here adds anything up.

export type { DashboardView };

/** The order the sections appear in, which is also the order a person usually works through them. */
export const SECTION_ORDER: readonly DashboardSectionKey[] = ['newRequests', 'pendingPayments', 'tasks', 'stock', 'subscribers'];

/** The sections the API sent, in display order. */
export const presentSections = (view: DashboardView): DashboardSectionKey[] => SECTION_ORDER.filter((k) => view.sections[k] !== undefined);

const brisbane = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' });

/** An instant as Brisbane time, such as "13 Nov 2026, 2:30 pm". */
export const formatInstant = (iso: string): string => brisbane.format(new Date(iso));

/** The race and year on one line, such as "Polar Circle Marathon 2026". */
export const tripLine = (raceName: string, year: number): string => `${raceName} ${year}`;

/** Where a booking is in the panel. */
export const bookingPath = (id: string): string => `/admin/bookings/${id}`;
export const editionPath = (id: string): string => `/admin/editions/${id}`;
export const racePath = (id: string): string => `/admin/races/${id}`;
