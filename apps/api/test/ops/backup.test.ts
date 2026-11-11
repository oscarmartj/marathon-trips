import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Task 8.6: backup and restore scripts run for real against PostgreSQL. The administrator connection comes from the
 * standard PGHOST / PGUSER / PGPASSWORD variables (CI sets them; locally see CLAUDE.md). A test database is built from
 * the real migrations, so the restore is proved on the real schema, grants and pg-boss tables.
 */
const root = resolve(__dirname, '../../../..');
const scripts = join(root, 'scripts/backup');
const migrations = join(root, 'apps/api/prisma/migrations');
const suffix = randomBytes(4).toString('hex');
const src = `mt_bk_src_${suffix}`;
const created: string[] = [src];
const tmp = mkdtempSync(join(tmpdir(), 'mt-backup-test-'));
const filesDir = join(tmp, 'files');
const outDir = join(tmp, 'out');
const remoteDir = join(tmp, 'remote');
const passFile = join(tmp, 'pass');
const wrongPassFile = join(tmp, 'wrong');

const baseEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C' });
function run(cmd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  const r = spawnSync(cmd, args, { env: { ...baseEnv(), ...env }, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const psql = (db: string, sql: string) => run('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]);
const scalar = (db: string, sql: string) => {
  const r = psql(db, sql);
  if (r.code !== 0) throw new Error(`psql failed: ${r.err}`);
  return r.out.trim();
};
const backupEnv = (extra: Record<string, string> = {}) => ({
  PGDATABASE: src, BACKUP_DIR: outDir, FILES_DIR: filesDir, BACKUP_REMOTE_KIND: 'dir', BACKUP_REMOTE_TARGET: remoteDir, ...extra,
});
const backup = (extra: Record<string, string> = {}) => run('bash', [join(scripts, 'backup.sh')], backupEnv(extra));
const bundles = (dir = outDir) => readdirSync(dir).filter((f) => /^mt-backup-.*\.tar(\.enc)?$/.test(f)).sort();
const restore = (bundle: string, db: string, filesTo: string, extra: string[] = [], env: Record<string, string> = {}) => {
  created.push(db);
  return run('bash', [join(scripts, 'restore.sh'), bundle, '--database', db, '--files-dir', filesTo, ...extra], { RESTORE_LIVE_DATABASE: src, ...env });
};
const newDb = () => `mt_bk_dst_${randomBytes(4).toString('hex')}`;
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

beforeAll(() => {
  expect(run('psql', ['-X', '-A', '-t', '-d', 'postgres', '-c', 'SELECT 1']).out.trim(), 'PGHOST, PGUSER and PGPASSWORD must give superuser access (see CLAUDE.md)').toBe('1');
  expect(scalar('postgres', "SELECT count(*) FROM pg_roles WHERE rolname IN ('mt_owner','mt_app','mt_privacy')"), 'run scripts/db-init.sh first').toBe('3');
  for (const d of [filesDir, outDir, remoteDir]) mkdirSync(d, { recursive: true });
  writeFileSync(passFile, 'correct horse battery staple\n');
  writeFileSync(wrongPassFile, 'not the passphrase\n');
  mkdirSync(join(filesDir, 'ab'), { recursive: true });
  writeFileSync(join(filesDir, 'ab', 'file-one.bin'), randomBytes(2048));
  writeFileSync(join(filesDir, 'file-two.txt'), 'second file\n');

  expect(psql('postgres', `CREATE DATABASE ${src} OWNER mt_owner`).code).toBe(0);
  const grants = `
    REVOKE ALL ON DATABASE ${src} FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${src} TO mt_app, mt_owner;
    REVOKE CREATE, TEMPORARY ON DATABASE ${src} FROM mt_app;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    ALTER SCHEMA public OWNER TO mt_owner;
    GRANT USAGE ON SCHEMA public TO mt_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE mt_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mt_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE mt_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mt_app;`;
  expect(run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', src], {}, grants).code).toBe(0);
  for (const m of readdirSync(migrations).filter((d) => /^\d{4}_/.test(d)).sort()) {
    const sql = `SET ROLE mt_owner;\n${readFileSync(join(migrations, m, 'migration.sql'), 'utf8')}`;
    const r = run('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', src], {}, sql);
    expect(r.code, `migration ${m}: ${r.err}`).toBe(0);
  }
  expect(psql(src, `INSERT INTO feature_flags (id, key, enabled, description, "updatedAt") SELECT gen_random_uuid(), 'test.flag' || g, g % 2 = 0, 'd', now() FROM generate_series(1, 25) g`).code).toBe(0);
});

afterAll(() => {
  for (const db of created) psql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  rmSync(tmp, { recursive: true, force: true });
});

describe('backup and restore (task 8.6)', () => {
  let bundle = '';

  it('backup_writes_bundle_checksum_offsite_copy_and_status', () => {
    const r = backup();
    expect(r.code, r.err).toBe(0);
    [bundle] = bundles();
    expect(bundle).toMatch(/^mt-backup-\d{8}T\d{6}Z\.tar$/);
    expect(existsSync(join(outDir, `${bundle}.sha256`))).toBe(true);
    expect(sha(join(remoteDir, bundle))).toBe(sha(join(outDir, bundle)));
    const status = JSON.parse(readFileSync(join(outDir, 'last-backup.json'), 'utf8'));
    expect(status).toMatchObject({ bundle, offsite: true, encrypted: false, sha256: sha(join(outDir, bundle)) });
    expect(Date.now() - Date.parse(status.finishedAt)).toBeLessThan(60_000);
  });

  it('restore_into_new_database_matches_counts_files_and_grants', () => {
    const db = newDb();
    const to = join(tmp, 'restored-1');
    const r = restore(join(outDir, bundle), db, to);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('row counts match');
    expect(scalar(db, 'SELECT count(*) FROM feature_flags')).toBe('25');
    expect(scalar(db, "SELECT count(*) FROM pgboss.queue")).toBe(scalar(src, 'SELECT count(*) FROM pgboss.queue'));
    expect(sha(join(to, 'ab', 'file-one.bin'))).toBe(sha(join(filesDir, 'ab', 'file-one.bin')));
    expect(readFileSync(join(to, 'file-two.txt'), 'utf8')).toBe('second file\n');
    // Ownership and grants survive: the API role reads and writes data, cannot create objects, and cannot use the database freely.
    expect(scalar(db, "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'feature_flags'")).toBe('mt_owner');
    expect(scalar(db, "SELECT has_table_privilege('mt_app', 'public.feature_flags', 'INSERT')")).toBe('t');
    expect(scalar(db, "SELECT has_table_privilege('mt_app', 'public.feature_flags', 'TRUNCATE')")).toBe('f');
    expect(scalar(db, "SELECT has_schema_privilege('mt_app', 'public', 'CREATE')")).toBe('f');
    expect(scalar(db, `SELECT has_database_privilege('mt_app', '${db}', 'CREATE')`)).toBe('f');
    expect(scalar(db, "SELECT has_schema_privilege('mt_app', 'pgboss', 'CREATE')")).toBe('f');
  });

  it('backup_is_consistent_while_the_site_is_writing', () => {
    // A writer inserts rows in the background while the backup runs; the counts in MANIFEST must still match the dump exactly.
    const sql = `DO $$ BEGIN FOR i IN 1..300 LOOP INSERT INTO feature_flags (id, key, enabled, description, "updatedAt") VALUES (gen_random_uuid(), 'live.' || clock_timestamp(), true, 'w', now()); COMMIT; PERFORM pg_sleep(0.01); END LOOP; END $$`;
    const writer = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', src, '-c', sql], { env: baseEnv(), stdio: 'ignore' });
    const before = scalar(src, 'SELECT count(*) FROM feature_flags');
    const b = backup();
    expect(b.code, b.err).toBe(0);
    expect(Number(scalar(src, 'SELECT count(*) FROM feature_flags'))).toBeGreaterThan(Number(before)); // it really was writing during the backup
    writer.kill();
    const latest = bundles().at(-1)!;
    const r = restore(join(outDir, latest), newDb(), join(tmp, 'restored-2'));
    expect(r.code, r.err).toBe(0);
  });

  it('encrypted_bundle_restores_with_the_passphrase_and_not_without_or_with_a_wrong_one', () => {
    const b = backup({ BACKUP_PASSPHRASE_FILE: passFile });
    expect(b.code, b.err).toBe(0);
    const enc = bundles().filter((f) => f.endsWith('.enc')).at(-1)!;
    expect(JSON.parse(readFileSync(join(outDir, 'last-backup.json'), 'utf8')).encrypted).toBe(true);
    expect(readFileSync(join(outDir, enc)).includes('feature_flags')).toBe(false); // nothing readable inside
    const ok = restore(join(outDir, enc), newDb(), join(tmp, 'restored-3'), [], { BACKUP_PASSPHRASE_FILE: passFile });
    expect(ok.code, ok.err).toBe(0);
    const wrong = newDb();
    const bad = restore(join(outDir, enc), wrong, join(tmp, 'restored-4'), [], { BACKUP_PASSPHRASE_FILE: wrongPassFile });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('cannot decrypt');
    expect(scalar('postgres', `SELECT count(*) FROM pg_database WHERE datname = '${wrong}'`)).toBe('0');
    const none = restore(join(outDir, enc), newDb(), join(tmp, 'restored-5'));
    expect(none.code).toBe(1);
    expect(none.err).toContain('BACKUP_PASSPHRASE_FILE');
  });

  it('damaged_bundle_is_rejected_before_any_database_is_created', () => {
    const copy = join(tmp, 'damaged', bundle);
    mkdirSync(join(tmp, 'damaged'), { recursive: true });
    writeFileSync(copy, readFileSync(join(outDir, bundle)));
    appendFileSync(copy, 'x');
    writeFileSync(`${copy}.sha256`, readFileSync(join(outDir, `${bundle}.sha256`)));
    const db = newDb();
    const r = restore(copy, db, join(tmp, 'restored-6'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('damaged or altered');
    expect(scalar('postgres', `SELECT count(*) FROM pg_database WHERE datname = '${db}'`)).toBe('0');
    expect(existsSync(join(tmp, 'restored-6'))).toBe(false);
  });

  it('manifest_row_counts_that_do_not_match_fail_the_restore', () => {
    // A bundle whose MANIFEST claims a different number of rows (without a sidecar checksum) must not pass as good.
    const dir = join(tmp, 'edited');
    mkdirSync(dir, { recursive: true });
    expect(run('tar', ['-xf', join(outDir, bundle), '-C', dir]).code).toBe(0);
    const manifest = join(dir, 'MANIFEST');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('public.feature_flags=25', 'public.feature_flags=26'));
    const edited = join(tmp, 'edited-bundle.tar');
    expect(run('tar', ['-cf', edited, '-C', dir, 'db.dump', 'files.tar', 'MANIFEST']).code).toBe(0);
    const r = restore(edited, newDb(), join(tmp, 'restored-7'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('row counts differ');
    expect(r.err).toContain('public.feature_flags');
  });

  it('existing_database_and_non_empty_directory_are_refused_and_the_live_database_needs_two_flags', () => {
    const existing = restore(join(outDir, bundle), src, join(tmp, 'restored-8'), [], { RESTORE_LIVE_DATABASE: 'someone_else' });
    expect(existing.code).toBe(1);
    expect(existing.err).toContain('already exists');
    const live = restore(join(outDir, bundle), src, join(tmp, 'restored-9'), ['--replace']);
    expect(live.code).toBe(1);
    expect(live.err).toContain('is the live database');
    expect(scalar(src, 'SELECT count(*) FROM feature_flags')).not.toBe('0'); // untouched
    const full = restore(join(outDir, bundle), newDb(), filesDir);
    expect(full.code).toBe(1);
    expect(full.err).toContain('is not empty');
    expect(existsSync(join(filesDir, 'file-two.txt'))).toBe(true);
  });

  it('failed_backup_leaves_no_bundle_and_keeps_the_previous_status', () => {
    const before = readFileSync(join(outDir, 'last-backup.json'), 'utf8');
    const count = bundles().length;
    const r = backup({ PGDATABASE: 'mt_bk_does_not_exist' });
    expect(r.code).not.toBe(0);
    expect(bundles().length).toBe(count);
    expect(readFileSync(join(outDir, 'last-backup.json'), 'utf8')).toBe(before);
    expect(readdirSync(outDir).filter((f) => f.startsWith('.work'))).toEqual([]);
  });

  it('failed_offsite_copy_fails_the_backup_and_the_status_is_not_updated', () => {
    const before = readFileSync(join(outDir, 'last-backup.json'), 'utf8');
    const r = backup({ BACKUP_REMOTE_TARGET: join(tmp, 'remote-does-not-exist') });
    expect(r.code).toBe(1);
    expect(readFileSync(join(outDir, 'last-backup.json'), 'utf8')).toBe(before);
  });

  it('local_only_needs_an_explicit_opt_in_and_production_needs_a_passphrase', () => {
    const none = backup({ BACKUP_REMOTE_KIND: 'none' });
    expect(none.code).toBe(1);
    expect(none.err).toContain('same server');
    const prod = backup({ APP_ENV: 'production' });
    expect(prod.code).toBe(1);
    expect(prod.err).toContain('personal data');
    const local = backup({ BACKUP_REMOTE_KIND: 'none', BACKUP_ALLOW_LOCAL_ONLY: 'yes' });
    expect(local.code, local.err).toBe(0);
    expect(JSON.parse(readFileSync(join(outDir, 'last-backup.json'), 'utf8')).offsite).toBe(false);
    const rclone = backup({ BACKUP_REMOTE_KIND: 'rclone', BACKUP_REMOTE_TARGET: '', PATH: '/usr/bin:/bin' });
    expect(rclone.code).toBe(1);
  });

  it('only_the_newest_bundles_are_kept_locally', () => {
    for (let i = 0; i < 3; i++) expect(backup({ BACKUP_KEEP: '2', BACKUP_REMOTE_KIND: 'none', BACKUP_ALLOW_LOCAL_ONLY: 'yes' }).code).toBe(0);
    expect(bundles().length).toBe(2);
    expect(readdirSync(outDir).filter((f) => f.endsWith('.sha256')).length).toBe(2);
  }, 30_000);

  it('verify_restore_restores_into_a_throwaway_database_and_removes_it', () => {
    const before = scalar('postgres', "SELECT count(*) FROM pg_database WHERE datname LIKE 'mt_verify_%'");
    const r = run('bash', [join(scripts, 'verify-restore.sh'), join(outDir, bundles().at(-1)!)]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('verify-restore: ok');
    expect(scalar('postgres', "SELECT count(*) FROM pg_database WHERE datname LIKE 'mt_verify_%'")).toBe(before);
  });
});
