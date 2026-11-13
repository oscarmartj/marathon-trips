import { CUSTOMER_DOCUMENT_KINDS } from '@mt/shared';
import type { BookingStatus, CustomerDocumentKind } from '@mt/shared';

// Which booking documents a customer can download, by booking status (plan docs/plans/5.1-customer-area.md, section 4).
// A confirmation and an itinerary only once the booking is confirmed; a voucher only once it is paid in full. Receipts
// are not here: task 4.6 is parked.
const AVAILABLE: Readonly<Record<CustomerDocumentKind, readonly BookingStatus[]>> = {
  confirmation: ['confirmed', 'balance_paid', 'completed'],
  itinerary: ['confirmed', 'balance_paid', 'completed'],
  voucher: ['balance_paid', 'completed'],
};

export const isDocumentKind = (v: string): v is CustomerDocumentKind => (CUSTOMER_DOCUMENT_KINDS as readonly string[]).includes(v);

export const documentsFor = (status: BookingStatus): CustomerDocumentKind[] => CUSTOMER_DOCUMENT_KINDS.filter((k) => AVAILABLE[k].includes(status));

/** A calendar date (a @db.Date value) as "10 June 2027", without any time-zone shift. */
export const longDate = (d: Date): string => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);

/** 123456 in AUD is "A$1,234.56". Only formats a stored amount; nothing is computed. */
export function formatMinor(minor: bigint, currency: string): string {
  const abs = minor < 0n ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'AUD' ? 'A$' : `${currency} `;
  return `${minor < 0n ? '-' : ''}${symbol}${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}
