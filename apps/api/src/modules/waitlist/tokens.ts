import { z } from 'zod';

/** The offer email (task 6.5). */
export const OFFER_TEMPLATE = { key: 'waitlist.offer', version: 1 } as const;

/** Business settings of the waiting list (task 6.5), with a conservative default. */
export const WAITLIST_SETTINGS = {
  offerHours: { key: 'waitlistOfferHours', fallback: 48, schema: z.number().int().min(1).max(336), description: 'Hours a waiting list offer holds its places before they go to the next person' },
} as const;
