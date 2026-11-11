import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSchema } from '../conventions/schema-conventions';
import { newId } from '../support/platform';

// Database-level guarantees of task 0.3: append-only audit tables, mt_privacy's narrow exception and its functions.
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set to run the database tests`);
  return v;
};
const app = new Pool({ connectionString: need('DATABASE_URL') });
const owner = new Pool({ connectionString: need('MIGRATION_DATABASE_URL') });
afterAll(async () => {
  await app.end();
  await owner.end();
});

const schemaDir = join(__dirname, '../../prisma/schema');
const models = parseSchema(readdirSync(schemaDir).filter((f) => f.endsWith('.prisma')).map((f) => ({ name: f, text: readFileSync(join(schemaDir, f), 'utf8') })));
const appendOnly = models.filter((m) => /@appendOnly\b/.test(m.doc));

const failure = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

/** Runs statements as mt_privacy (mt_owner may SET ROLE to it), always resetting the role. */
async function asPrivacy<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query('SET ROLE mt_privacy');
    return await fn(c);
  } finally {
    await c.query('RESET ROLE').catch(() => undefined);
    c.release();
  }
}

async function insertAudit(pool: Pool, opts: { occurredAt?: string; subjectUserId?: string | null } = {}): Promise<{ logId: string; valueId: string }> {
  const logId = newId();
  const valueId = newId();
  await pool.query(
    `INSERT INTO audit_logs (id, "occurredAt", "actorType", action, "entityType", "entityId", changes)
     VALUES ($1, COALESCE($2::timestamptz, now()), 'system', 'test.audit.row', 'Test', $3, '{"x":"[pii]"}')`,
    [logId, opts.occurredAt ?? null, newId()],
  );
  await pool.query(
    `INSERT INTO audit_pii_values (id, "auditLogId", field, before, after, "subjectUserId") VALUES ($1, $2, 'x', '"a"', '"b"', $3)`,
    [valueId, logId, opts.subjectUserId ?? null],
  );
  return { logId, valueId };
}

describe('append-only tables (plan 4.9)', () => {
  it('every_append_only_model_has_trigger', async () => {
    expect(appendOnly.map((m) => m.name).sort()).toEqual(expect.arrayContaining(['AuditLog', 'AuditPiiValue']));
    for (const m of appendOnly) {
      const { rows } = await owner.query(
        `SELECT t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = $1 AND NOT t.tgisinternal AND t.tgenabled <> 'D'`,
        [m.table],
      );
      // tgtype bits: 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE, 2 = BEFORE.
      const types = rows.map((r) => Number(r.tgtype));
      expect(types.some((t) => (t & 2) && (t & 8) && (t & 16)), `${m.name} UPDATE/DELETE trigger`).toBe(true);
      expect(types.some((t) => (t & 2) && (t & 32)), `${m.name} TRUNCATE trigger`).toBe(true);
    }
  });

  it('immutable_tables_have_no_fk_to_deletable_rows', async () => {
    const tables = appendOnly.map((m) => m.table);
    const { rows } = await owner.query(
      `SELECT c.conrelid::regclass::text AS src, c.confrelid::regclass::text AS dst FROM pg_constraint c
       WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY($1)`,
      [tables],
    );
    for (const r of rows) expect(tables, `${r.src} -> ${r.dst}`).toContain(r.dst);
  });

  it('audit_log_immutable_for_every_role', async () => {
    const { logId } = await insertAudit(app);
    // mt_app has no UPDATE or DELETE privilege at all.
    expect(await failure(() => app.query(`UPDATE audit_logs SET action = 'x' WHERE id = $1`, [logId]))).toMatch(/permission denied/);
    expect(await failure(() => app.query(`DELETE FROM audit_logs WHERE id = $1`, [logId]))).toMatch(/permission denied/);
    expect(await failure(() => app.query(`TRUNCATE audit_logs`))).toMatch(/permission denied/);
    // The owner has the privileges but the trigger refuses.
    expect(await failure(() => owner.query(`UPDATE audit_logs SET action = 'x' WHERE id = $1`, [logId]))).toMatch(/append-only/);
    expect(await failure(() => owner.query(`DELETE FROM audit_logs WHERE id = $1`, [logId]))).toMatch(/append-only/);
    expect(await failure(() => owner.query(`TRUNCATE audit_logs, audit_pii_values`))).toMatch(/append-only/);
    // mt_privacy neither.
    expect(await asPrivacy((c) => failure(() => c.query(`DELETE FROM audit_logs WHERE id = $1`, [logId])))).toMatch(/permission denied|append-only/);
    expect(await asPrivacy((c) => failure(() => c.query(`UPDATE audit_logs SET action = 'x' WHERE id = $1`, [logId])))).toMatch(/permission denied|append-only/);
    const still = await owner.query(`SELECT action FROM audit_logs WHERE id = $1`, [logId]);
    expect(still.rows).toEqual([{ action: 'test.audit.row' }]);
  });

  it('mt_privacy_exception_limited: only DELETE on audit_pii_values, never UPDATE, nothing elsewhere', async () => {
    const { valueId } = await insertAudit(app);
    expect(await failure(() => app.query(`DELETE FROM audit_pii_values WHERE id = $1`, [valueId]))).toMatch(/permission denied/);
    expect(await failure(() => owner.query(`DELETE FROM audit_pii_values WHERE id = $1`, [valueId]))).toMatch(/append-only/);
    expect(await failure(() => owner.query(`UPDATE audit_pii_values SET after = '"z"' WHERE id = $1`, [valueId]))).toMatch(/append-only/);
    expect(await asPrivacy((c) => failure(() => c.query(`UPDATE audit_pii_values SET after = '"z"' WHERE id = $1`, [valueId])))).toMatch(/permission denied|append-only/);
    expect(await asPrivacy((c) => failure(() => c.query(`SELECT 1 FROM users LIMIT 1`)))).toMatch(/permission denied/);
    expect(await asPrivacy((c) => failure(() => c.query(`DELETE FROM feature_flags WHERE key = 'never'`)))).toMatch(/permission denied/);
    // The one thing it may do.
    const deleted = await asPrivacy((c) => c.query(`DELETE FROM audit_pii_values WHERE id = $1`, [valueId]));
    expect(deleted.rowCount).toBe(1);
  });

  it('mt_privacy_functions_fixed_search_path_execute_only_mt_app', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, COALESCE(array(SELECT (aclexplode(p.proacl)).grantee::regrole::text), '{}') AS grantees
       FROM pg_proc p WHERE pg_get_userbyid(p.proowner) = 'mt_privacy'`,
    );
    expect(rows.map((r) => r.proname)).toContain('privacy_purge_expired');
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect(r.proconfig, r.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect([...new Set(r.grantees as string[])].sort(), r.proname).toEqual(['mt_app', 'mt_privacy']);
    }
    const pub = await owner.query(`SELECT has_function_privilege('public', 'privacy_purge_expired()', 'EXECUTE') AS p`);
    expect(pub.rows[0].p).toBe(false);
  });

  it('privacy_purge_deletes_only_expired_unowned', async () => {
    const old = await insertAudit(app, { occurredAt: '2015-01-01T00:00:00Z' });
    const oldOwned = await insertAudit(app, { occurredAt: '2015-01-01T00:00:00Z', subjectUserId: newId() });
    const recent = await insertAudit(app);
    const { rows } = await app.query(`SELECT privacy_purge_expired() AS n`);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    const left = await app.query(`SELECT id FROM audit_pii_values WHERE id = ANY($1)`, [[old.valueId, oldOwned.valueId, recent.valueId]]);
    expect(left.rows.map((r) => r.id).sort()).toEqual([oldOwned.valueId, recent.valueId].sort());
    const ran = await app.query(`SELECT 1 FROM audit_logs WHERE action = 'privacy.retention.purged' AND "occurredAt" > now() - interval '1 minute'`);
    expect(ran.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('non_empty_role_scope_rejected_and_denies (database layer) and roles only for staff', async () => {
    const roleId = newId();
    const staffId = newId();
    const customerId = newId();
    await app.query(`INSERT INTO roles (id, key, name, "updatedAt") VALUES ($1, $2, 'Scoped test', now())`, [roleId, `t${roleId.slice(0, 8)}`]);
    await app.query(`INSERT INTO users (id, kind, email, "updatedAt") VALUES ($1, 'staff', $2, now()), ($3, 'customer', $4, now())`, [staffId, `${staffId}@example.test`, customerId, `${customerId}@example.test`]);
    expect(await failure(() => app.query(`INSERT INTO user_roles ("userId", "roleId", scope) VALUES ($1, $2, '{"editionIds":[]}')`, [staffId, roleId]))).toMatch(/user_roles_scope_null_check/);
    expect(await failure(() => app.query(`INSERT INTO user_roles ("userId", "userKind", "roleId") VALUES ($1, 'customer', $2)`, [customerId, roleId]))).toMatch(/user_roles_staff_only_check/);
    expect(await failure(() => app.query(`INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)`, [customerId, roleId]))).toMatch(/user_roles_userId_userKind_fkey/);
    expect(await failure(() => app.query(`UPDATE users SET "passwordHash" = 'x' WHERE id = $1`, [customerId]))).toMatch(/users_staff_only_credentials_check/);
    await app.query(`DELETE FROM users WHERE id = ANY($1)`, [[staffId, customerId]]);
    await app.query(`DELETE FROM roles WHERE id = $1`, [roleId]);
  });
});
