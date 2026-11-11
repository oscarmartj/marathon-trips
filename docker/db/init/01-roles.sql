-- Database roles (plan 0.1, section 4.9). Development/test only: the passwords are not secrets.
-- mt_owner owns every object and runs migrations; mt_app is the API's role with no CREATE;
-- mt_privacy is NOLOGIN and will own the erasure functions (task 0.3 adds them).
-- Runs against the maintenance database as a superuser; safe to run again.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mt_owner') THEN
    CREATE ROLE mt_owner LOGIN PASSWORD 'mt_owner_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mt_app') THEN
    CREATE ROLE mt_app LOGIN PASSWORD 'mt_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mt_privacy') THEN
    CREATE ROLE mt_privacy NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

SELECT 'CREATE DATABASE marathon_trips OWNER mt_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'marathon_trips')\gexec

REVOKE ALL ON DATABASE marathon_trips FROM PUBLIC;
GRANT CONNECT ON DATABASE marathon_trips TO mt_app, mt_owner;
-- No CREATE or TEMPORARY for the API role.
REVOKE CREATE, TEMPORARY ON DATABASE marathon_trips FROM mt_app;

\connect marathon_trips
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO mt_owner;
GRANT USAGE ON SCHEMA public TO mt_app;
-- Tables and sequences that mt_owner creates later are usable by mt_app, without TRUNCATE.
ALTER DEFAULT PRIVILEGES FOR ROLE mt_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mt_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mt_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mt_app;
