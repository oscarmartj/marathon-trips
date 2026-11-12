import { Prisma } from '../../generated/prisma/client';
import { conflict } from '../http/api-error';
import type { PrismaService } from './prisma.service';

/** SQLSTATEs after which the whole transaction can simply run again (plan 0.1, 6.3). */
const RETRYABLE = new Set(['40001', '40P01']);

/** True for a serialisation failure or a deadlock, however Prisma wraps it (P2034 or the raw SQLSTATE). */
export function isRetryableTransactionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
  const text = err instanceof Error ? `${err.message} ${JSON.stringify((err as { meta?: unknown }).meta ?? {})}` : '';
  for (const code of RETRYABLE) if (text.includes(code)) return true;
  return /could not serialize access|deadlock detected/.test(text);
}

export interface RunTransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Including the first. Default 3 (plan 0.1, 6.3). */
  maxAttempts?: number;
  timeout?: number;
}

/**
 * Runs `fn` in a transaction and runs it again, after a short random wait, when PostgreSQL aborts it with a
 * serialisation failure or a deadlock. When the attempts run out the caller gets a 409 `busy_try_again`, never a 500
 * and never the raw 40001 (plan 2.2, section 15, point 3). `fn` must be safe to run more than once: everything it
 * writes is in the transaction that is rolled back.
 */
export async function runTransaction<T>(prisma: PrismaService, fn: (tx: Prisma.TransactionClient) => Promise<T>, opts: RunTransactionOptions = {}): Promise<T> {
  const attempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: opts.isolationLevel, timeout: opts.timeout });
    } catch (err) {
      if (!isRetryableTransactionError(err)) throw err;
      if (attempt >= attempts) throw conflict('busy_try_again', 'Many people are doing this at once. Try again.');
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20 * attempt)));
    }
  }
}
