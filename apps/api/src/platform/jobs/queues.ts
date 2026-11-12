import { z } from 'zod';

/**
 * Every pg-boss queue the API uses, declared once. The migration that creates `pgboss` also creates these queues
 * (not partitioned, so no DDL at runtime) and a test compares both lists. A module that needs a queue adds it here
 * and in a new migration; the API refuses to start when a declared queue is missing (JobsService.assertQueues).
 * Job data holds identifiers only (plan 4.5).
 */
export interface QueueDef {
  readonly name: string;
  readonly data: z.ZodType<object>;
  /** Options as written in the migration, compared by the test. */
  readonly options: {
    readonly policy: 'short';
    readonly retryLimit: number;
    readonly retryDelay: number;
    readonly retryBackoff?: boolean;
    readonly expireInSeconds: number;
    readonly deleteAfterSeconds: number;
  };
}

const uuid = z.string().uuid();

export const QUEUES = {
  eventsDeliver: {
    name: 'events.deliver',
    data: z.object({ deliveryId: uuid }).strict(),
    options: { policy: 'short', retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300, deleteAfterSeconds: 604800 },
  },
  eventsMaintenance: {
    name: 'events.maintenance',
    data: z.object({}).strict(),
    options: { policy: 'short', retryLimit: 2, retryDelay: 60, expireInSeconds: 600, deleteAfterSeconds: 604800 },
  },
  mailSend: {
    name: 'mail.send',
    data: z.object({ outboundEmailId: uuid }).strict(),
    options: { policy: 'short', retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300, deleteAfterSeconds: 604800 },
  },
  webhooksSend: {
    name: 'webhooks.send',
    data: z.object({ deliveryId: uuid }).strict(),
    options: { policy: 'short', retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 120, deleteAfterSeconds: 604800 },
  },
  webhooksMaintenance: {
    name: 'webhooks.maintenance',
    data: z.object({}).strict(),
    options: { policy: 'short', retryLimit: 2, retryDelay: 60, expireInSeconds: 600, deleteAfterSeconds: 604800 },
  },
  bookingsMaintenance: {
    name: 'bookings.maintenance',
    data: z.object({}).strict(),
    options: { policy: 'short', retryLimit: 2, retryDelay: 60, expireInSeconds: 600, deleteAfterSeconds: 604800 },
  },
  // Task 3.1: process one stored gateway webhook; sync, cancel or expire one payment attempt; the payments sweep.
  paymentsWebhooks: {
    name: 'payments.webhooks',
    data: z.object({ webhookEventId: uuid }).strict(),
    options: { policy: 'short', retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300, deleteAfterSeconds: 604800 },
  },
  paymentsAttempts: {
    name: 'payments.attempts',
    data: z.object({ paymentId: uuid, action: z.enum(['sync', 'cancel', 'expire']) }).strict(),
    options: { policy: 'short', retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 300, deleteAfterSeconds: 604800 },
  },
  paymentsMaintenance: {
    name: 'payments.maintenance',
    data: z.object({}).strict(),
    options: { policy: 'short', retryLimit: 2, retryDelay: 60, expireInSeconds: 600, deleteAfterSeconds: 604800 },
  },
  authMaintenance: {
    name: 'auth.maintenance',
    data: z.object({}).strict(),
    options: { policy: 'short', retryLimit: 2, retryDelay: 60, expireInSeconds: 600, deleteAfterSeconds: 604800 },
  },
} as const satisfies Record<string, QueueDef>;

export type QueueKey = keyof typeof QUEUES;
export const QUEUE_LIST: readonly QueueDef[] = Object.values(QUEUES);
