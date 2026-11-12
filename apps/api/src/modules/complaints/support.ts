import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ApiError, conflict, notFound } from '../../platform/http/api-error';

export type Tx = Prisma.TransactionClient;

/** '2027-05-02' to a Date at UTC midnight (columns are @db.Date). */
export const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
export const fromDate = (d: Date): string => d.toISOString().slice(0, 10);

const DATE_KEYS = /(Date)$/;

/** JSON-safe copy of a row for audit snapshots: calendar-date columns as YYYY-MM-DD, other dates as ISO strings. */
export function view<T>(value: T): T {
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return DATE_KEYS.test(key) ? v.toISOString().slice(0, 10) : v.toISOString();
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

export const versionConflict = (): ApiError => conflict('version_conflict', 'Someone else changed this. Reload and try again.');

/** Throws 404 when the row is missing, 409 when its version is not the one the caller read. */
export function assertVersion<T extends { version: number }>(row: T | null, expected: number): asserts row is T {
  if (!row) throw notFound('complaint_not_found', 'Complaint not found');
  if (row.version !== expected) throw versionConflict();
}

export const isUniqueViolation = (err: unknown, field?: string): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && (field === undefined || JSON.stringify(err.meta ?? {}).includes(field));

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Human references CP-XXXXXX: six random Crockford base32 characters (30 bits), never sequential, so a reference tells
 * nobody how many complaints there are. A class so a test can force a collision.
 */
@Injectable()
export class ComplaintReferences {
  next(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    let out = 'CP-';
    for (const b of bytes) out += CROCKFORD[b & 31];
    return out;
  }
}
