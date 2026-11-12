import { Prisma } from '../../generated/prisma/client';
import { ApiError, conflict, notFound } from '../../platform/http/api-error';

export type Tx = Prisma.TransactionClient;

/** '2027-05-02' to a Date at UTC midnight (columns are @db.Date). */
export const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
export const fromDate = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

const DATE_KEYS = /(Date)$|^(startDate|endDate)$/;

/**
 * JSON-safe copy of a row for responses and audit snapshots: bigint as a string of digits, calendar-date columns as
 * YYYY-MM-DD, other dates as ISO strings.
 */
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

/** Runs a write and turns a unique-constraint failure into a 409 with a fixed message. */
export async function orConflict<T>(code: string, message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict(code, message);
    throw err;
  }
}

/** Runs a removal and turns a foreign-key failure into a 409: something still points at the row (plan 2.1, G1). */
export async function orInUse<T>(code: string, message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') throw conflict(code, message);
    throw err;
  }
}

/** Row lock on a package: FOR SHARE for changes to its options, FOR UPDATE for its sale status and price versions. */
export async function lockPackage(tx: Tx, id: string, mode: 'share' | 'update'): Promise<void> {
  if (mode === 'share') await tx.$queryRaw`SELECT 1 FROM packages WHERE id = ${id}::uuid FOR SHARE`;
  else await tx.$queryRaw`SELECT 1 FROM packages WHERE id = ${id}::uuid FOR UPDATE`;
}

export const versionConflict = (): ApiError => conflict('version_conflict', 'Someone else changed this. Reload and try again.');

/** Throws 404 when the row is missing, 409 when its version is not the one the caller read. */
export function assertVersion(row: { version: number } | null, expected: number, what = 'Not found'): asserts row is { version: number } {
  if (!row) throw notFound('not_found', what);
  if (row.version !== expected) throw versionConflict();
}

/** Keeps only the keys whose value is not undefined (an omitted field in a PATCH body). */
export function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
