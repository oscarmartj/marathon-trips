import { fromPrisma } from 'pg-boss';
import type { Db } from 'pg-boss';
import type { Prisma } from '../../generated/prisma/client';

/**
 * Lets pg-boss run its statements inside a Prisma interactive transaction, so a job is enqueued in the same
 * transaction as the change that needs it (outbox dispatch, email queueing). Uses pg-boss's own Prisma adapter.
 */
export const bossDb = (tx: Prisma.TransactionClient): Db => fromPrisma(tx);
