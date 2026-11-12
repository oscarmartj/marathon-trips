import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

export type Tx = Prisma.TransactionClient;

/** The database clock, read inside the transaction after its locks (plan 2.4, section 4, step 6). */
export async function dbNow(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
  return row!.at;
}

/** JSON-safe copy: bigint as a string of digits, instants as ISO strings, calendar dates (…Date) as YYYY-MM-DD. */
export function jsonOf<T>(value: T): unknown {
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return /Date$/.test(key) ? v.toISOString().slice(0, 10) : v.toISOString();
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value);
}

/** '2027-05-02' to a Date at UTC midnight (columns are @db.Date). */
export const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Human references MT-XXXXXX: six random Crockford base32 characters (30 bits), never sequential (plan 0.1, 1.2). A
 * class so a test can force a collision.
 */
@Injectable()
export class ReferenceGenerator {
  next(): string {
    const bytes = randomBytes(6);
    let out = 'MT-';
    for (const b of bytes) out += CROCKFORD[b & 31];
    return out;
  }
}
