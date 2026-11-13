import type { BookingStatus } from '@mt/shared';

/** Booking states in which a payment can be started (plan 0.1, 6.2, "create an attempt"). */
export const PAYABLE_STATES: readonly BookingStatus[] = ['approved', 'deposit_paid', 'confirmed'];

/** READ COMMITTED with short limits, like booking requests (plan 2.4, section 4). */
export const PAYMENT_TX_OPTIONS = { isolationLevel: 'ReadCommitted' as const, timeout: 15_000, maxWait: 5_000 };
