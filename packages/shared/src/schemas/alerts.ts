import { z } from 'zod';
import { emailSchema, oneTimeTokenSchema } from './auth';
import { slugSchema } from './catalogue';

// Opening alerts (task 5.3). Strict objects: an unknown field is a 422, so a token only travels in its own field.

/** Subscribe to a race, or to one edition of it when `year` is given. */
export const alertSubscribeSchema = z.strictObject({ email: emailSchema, raceSlug: slugSchema, year: z.number().int().min(1900).max(2200).optional() });
export const alertConfirmSchema = z.strictObject({ token: oneTimeTokenSchema });
/** `token` is the HMAC in the unsubscribe link: 64 hexadecimal characters. */
export const alertUnsubscribeSchema = z.strictObject({ subscriptionId: z.uuid(), token: z.string().regex(/^[0-9a-f]{64}$/) });
