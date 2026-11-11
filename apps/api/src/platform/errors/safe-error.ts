import { Prisma } from '../../generated/prisma/client';

/**
 * Stored errors (EventDelivery.lastError, OutboundEmail.error, pg-boss output) carry a code and a fixed message
 * from a known class, never the original text: PostgreSQL and Prisma errors quote values in `detail`, `where` and
 * `meta` (plan 4.1). Anything unknown becomes `unexpected_error`.
 */
export interface SafeErrorInfo {
  code: string;
  message: string;
}

/** Throw this from code that wants its code stored as is. The message must never contain values. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const PRISMA_MESSAGES: Record<string, string> = {
  P2002: 'A unique constraint was violated',
  P2003: 'A foreign key constraint was violated',
  P2025: 'A required record was not found',
  P2034: 'A transaction conflict occurred',
};

export function safeError(err: unknown): SafeErrorInfo {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return { code: `prisma_${err.code}`, message: PRISMA_MESSAGES[err.code] ?? 'A database request failed' };
  }
  // node-postgres errors carry a five-character SQLSTATE in `code`; the text may quote values, so it is dropped.
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    return { code: `pg_${code}`, message: 'A database error occurred' };
  }
  return { code: 'unexpected_error', message: 'An unexpected error occurred' };
}

export const formatSafeError = (info: SafeErrorInfo): string => `${info.code}: ${info.message}`;

/** What jobs throw to pg-boss: no original message and no stack, so nothing sensitive reaches pgboss.job.output. */
export class SafeJobError extends Error {
  constructor(info: SafeErrorInfo) {
    super(formatSafeError(info));
    this.name = 'SafeJobError';
    this.stack = undefined;
  }
}
