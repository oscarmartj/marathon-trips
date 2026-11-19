import { z } from 'zod';
import { ISO_COUNTRY_CODES } from '../iso-countries';
import { uuidSchema, versionSchema } from './catalogue';
import { quoteRequestSchema } from './pricing';
import { cancellationPolicyRefSchema } from './cancellations';

// Booking requests (task 2.4, plan docs/plans/2.4-booking-requests.md). A request carries a configuration and the lead
// contact, never an amount, a currency, a date or a status: the API prices it with its engine and stores the result.

export const BOOKING_STATUSES = ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed', 'declined', 'expired', 'cancelled', 'refunded'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Human reference of a booking: MT- and six Crockford base32 characters. */
export const BOOKING_REFERENCE_PATTERN = /^MT-[0-9A-HJKMNP-TV-Z]{6}$/;
export const bookingReferenceSchema = z.string().regex(BOOKING_REFERENCE_PATTERN);

// No control characters and no angle brackets in a name: it ends up in emails and the panel.
const NAME = /^[^\p{Cc}<>]+$/u;
const nameSchema = z.string().trim().min(1).max(100).regex(NAME);

/** The lead contact sent with a request. The email address is never here: it is the one the magic link verified. */
export const bookingContactSchema = z.strictObject({
  givenName: nameSchema,
  familyName: nameSchema,
  phone: z.string().trim().regex(/^\+?[0-9 ]{6,20}$/).optional(),
  // An assigned ISO 3166-1 alpha-2 code: ZZ marks an erased customer, so it (and XX, AA...) is never accepted.
  countryOfResidence: z.string().trim().toUpperCase().refine((c) => ISO_COUNTRY_CODES.has(c), 'Use a two-letter ISO 3166-1 country code, such as AU'),
});
export type BookingContact = z.infer<typeof bookingContactSchema>;

/** A booking request: exactly a quote request (strict at every level) plus the contact. */
/** Task 6.4 (plan section 13, M2): the cancellation policy the customer was shown; null when the package showed none. */
export const bookingRequestSchema = quoteRequestSchema.extend({ contact: bookingContactSchema, cancellationPolicy: cancellationPolicyRefSchema.nullable().default(null) }).strict();
export type BookingRequest = z.infer<typeof bookingRequestSchema>;

const staffReason = z.string().trim().min(1).max(500);

/** Approving: the version the panel read, and an optional note. */
export const approveBookingSchema = z.strictObject({ version: versionSchema, reason: staffReason.optional() });
/** Declining or cancelling: the version the panel read and a reason, always. */
export const closeBookingSchema = z.strictObject({ version: versionSchema, reason: staffReason });

export const listBookingsQuerySchema = z.strictObject({
  status: z.enum(BOOKING_STATUSES).optional(),
  packageId: uuidSchema.optional(),
  editionId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
  /** Task 2.5: part of a reference, a name or an email address. */
  q: z.string().trim().min(2).max(100).optional(),
  cursor: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

// ---- Customers in the panel (task 2.5) ----

/** Staff create a customer with an email address that no customer has yet; the person links it by signing in. */
export const createCustomerSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  givenName: nameSchema,
  familyName: nameSchema,
  phone: z.string().trim().regex(/^\+?[0-9 ]{6,20}$/).optional(),
  countryOfResidence: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
});
export const updateCustomerSchema = z.strictObject({
  givenName: nameSchema.optional(),
  familyName: nameSchema.optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ]{6,20}$/).nullable().optional(),
  countryOfResidence: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
  version: versionSchema,
});
export const listCustomersQuerySchema = z.strictObject({
  q: z.string().trim().min(2).max(100).optional(),
  cursor: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
