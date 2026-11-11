import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client';

// Integration tests against a real PostgreSQL (docker compose db, or a local server prepared with
// `pnpm db:init` and `pnpm db:migrate`). They fail, not skip, when the database is unreachable.
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

const rejected = async (pool: Pool, sql: string): Promise<string> => {
  try {
    await pool.query(sql);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

describe('database roles (plan 4.9)', () => {
  it('the API connects as mt_app and migrations as mt_owner', async () => {
    expect((await app.query('select current_user u')).rows[0].u).toBe('mt_app');
    expect((await owner.query('select current_user u')).rows[0].u).toBe('mt_owner');
  });

  it('mt_app_has_no_create_privilege', async () => {
    const { rows } = await app.query(
      `select has_schema_privilege('mt_app','public','CREATE') s,
              has_database_privilege('mt_app', current_database(), 'CREATE') d,
              has_database_privilege('mt_app', current_database(), 'TEMPORARY') t`,
    );
    expect(rows[0]).toEqual({ s: false, d: false, t: false });
    expect(await rejected(app, 'create table mt_app_should_not_exist (i int)')).toMatch(/permission denied/);
    expect(await rejected(app, 'create temporary table t (i int)')).toMatch(/permission denied/);
  });

  it('mt_app owns nothing and cannot truncate', async () => {
    const own = await owner.query(
      `select count(*)::int n from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = 'mt_app'`,
    );
    expect(own.rows[0].n).toBe(0);
    const priv = await app.query(`select has_table_privilege('mt_app','seed_runs','TRUNCATE') t, has_table_privilege('mt_app','seed_runs','SELECT,INSERT,UPDATE,DELETE') crud`);
    expect(priv.rows[0]).toEqual({ t: false, crud: true });
    expect(await rejected(app, 'truncate seed_runs')).toMatch(/permission denied/);
    expect(await rejected(app, 'alter table seed_runs add column x int')).toMatch(/must be owner/);
  });

  it('every application table is owned by mt_owner', async () => {
    const { rows } = await owner.query(
      `select c.relname from pg_class c join pg_roles r on r.oid = c.relowner
       where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace and r.rolname <> 'mt_owner'`,
    );
    expect(rows).toEqual([]);
  });

  it('mt_privacy exists and cannot log in', async () => {
    const { rows } = await owner.query(`select rolcanlogin from pg_roles where rolname = 'mt_privacy'`);
    expect(rows).toEqual([{ rolcanlogin: false }]);
  });

  it('the standard extensions from migration 0001 are installed', async () => {
    const { rows } = await owner.query(`select extname from pg_extension where extname in ('citext','pg_trgm','btree_gist') order by 1`);
    expect(rows.map((r) => r.extname)).toEqual(['btree_gist', 'citext', 'pg_trgm']);
  });
});

describe('seed', () => {
  it('is idempotent and refuses production', async () => {
    const { seed } = await import('../prisma/seed/seed');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: need('DATABASE_URL') }) });
    try {
      await seed(prisma, 'test');
      await seed(prisma, 'test');
      expect(await prisma.seedRun.count({ where: { name: 'base' } })).toBe(1);
      await expect(seed(prisma, 'production')).rejects.toThrow(/production/);
    } finally {
      await prisma.$disconnect();
    }
  });
});
