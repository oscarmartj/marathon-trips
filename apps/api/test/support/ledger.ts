// Test helpers for the payment ledger (task 3.3).
import pg from 'pg';
import { LedgerService } from '../../src/modules/payments/core/ledger.service';
import type { TestApp } from './auth';

/** A direct connection: `owner` runs as mt_owner (migrations role), `app` as mt_app (the API's role). */
export async function connect(as: 'owner' | 'app'): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: as === 'owner' ? process.env.MIGRATION_DATABASE_URL : process.env.DATABASE_URL });
  await c.connect();
  return c;
}

/** Runs statements in one transaction and returns the error code it ended with (null when it committed). */
export async function txError(c: pg.Client, statements: Array<[string, unknown[]?]>): Promise<string | null> {
  try {
    await c.query('BEGIN');
    for (const [sql, params] of statements) await c.query(sql, params ?? []);
    await c.query('COMMIT');
    return null;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    return (err as { code?: string }).code ?? 'error';
  }
}

export interface LedgerRow {
  idempotencyKey: string;
  kind: string;
  entries: Record<string, bigint>;
}

/** The booking's ledger: one row per transaction, entries by account code (clearing accounts as `clearing`). */
export async function ledgerOf(t: TestApp, bookingId: string): Promise<LedgerRow[]> {
  const txs = await t.prisma.ledgerTransaction.findMany({ where: { bookingId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], include: { entries: true } });
  return txs.map((x) => ({
    idempotencyKey: x.idempotencyKey,
    kind: x.kind,
    entries: Object.fromEntries(x.entries.map((e) => [e.accountCode.startsWith('provider_clearing:') ? 'clearing' : e.accountCode, e.amountMinor])),
  }));
}

export const balancesOf = (t: TestApp, bookingId: string, currency = 'AUD') => t.prisma.$transaction((tx) => t.app.get(LedgerService).customerBalances(tx, bookingId, currency, 'test'));
