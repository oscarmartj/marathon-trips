import { z } from 'zod';
import { uuidSchema } from './catalogue';

// The waiting list (task 2.6). Joining happens through POST /booking-requests: the API decides from the country of
// residence whether a request becomes a booking request or a waiting list entry. Only the panel lists entries.

export const WAITLIST_STATUSES = ['waiting', 'offered', 'converted', 'expired', 'withdrawn'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const listWaitlistQuerySchema = z.strictObject({
  packageId: uuidSchema.optional(),
  status: z.enum(WAITLIST_STATUSES).optional(),
  /** `<packageId>:<position>` of the last entry of the previous page. */
  cursor: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,10}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
