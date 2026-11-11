-- Production roles with real passwords, then the same grants as development (docker/db/init/01-roles.sql, which
-- skips roles that already exist). Run once as the postgres superuser; see docs/deploy/guide.md, step 6.
-- Passwords come from the environment of psql (\getenv), so they never appear in the process list or in this file.
\getenv owner_pw MT_OWNER_PASSWORD
\getenv app_pw MT_APP_PASSWORD
\if :{?owner_pw}
\else
\echo 'MT_OWNER_PASSWORD is not set'
\quit
\endif
\if :{?app_pw}
\else
\echo 'MT_APP_PASSWORD is not set'
\quit
\endif
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mt_owner') AS make_owner \gset
\if :make_owner
CREATE ROLE mt_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
\endif
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mt_app') AS make_app \gset
\if :make_app
CREATE ROLE mt_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
\endif
\i /01-roles.sql
