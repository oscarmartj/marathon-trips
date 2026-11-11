#!/usr/bin/env bash
# Creates the mt_owner / mt_app / mt_privacy roles and the databases on a PostgreSQL server you
# can administer. docker compose does the same via docker/db/init. Idempotent. Development only.
# Usage: PGHOST=... PGUSER=postgres bash scripts/db-init.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
psql -v ON_ERROR_STOP=1 -d postgres -f "$here/docker/db/init/01-roles.sql"
