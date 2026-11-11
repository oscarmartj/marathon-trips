#!/usr/bin/env bash
# Restores a bundle made by backup.sh into a NEW database and an empty directory, then proves the data matches the
# MANIFEST (task 8.6). It never touches the live database unless you say so twice.
#
#   PGHOST=... PGUSER=postgres PGPASSWORD=... [BACKUP_PASSPHRASE_FILE=...] \
#   bash scripts/backup/restore.sh <bundle> --database marathon_trips_restored --files-dir /tmp/restored-files
#
# The PostgreSQL user must be a superuser (it creates the database and restores ownership). The roles mt_owner, mt_app
# and mt_privacy must already exist (deploy/db-init-prod.sql, or scripts/db-init.sh in development).
#   --replace                        allow an existing target database / non-empty files directory (dropped / emptied first)
#   --i-know-this-replaces-live-data also needed when the target is the live database (RESTORE_LIVE_DATABASE, default marathon_trips)
# Exit status 0 only when the checksums and every row count match.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

bundle="" db="" files_dir="" replace=no live_ok=no
while [ $# -gt 0 ]; do
  case "$1" in
    --database) db="${2:-}"; shift 2 ;;
    --files-dir) files_dir="${2:-}"; shift 2 ;;
    --replace) replace=yes; shift ;;
    --i-know-this-replaces-live-data) live_ok=yes; shift ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$bundle" ] || die "only one bundle"; bundle="$1"; shift ;;
  esac
done
[ -f "$bundle" ] || die "usage: restore.sh <bundle> --database <name> --files-dir <dir> [--replace]"
[[ "$db" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "--database must be a simple lower-case name"
[ -n "$files_dir" ] || die "--files-dir is required"
for t in psql pg_restore tar sha256sum; do need "$t"; done
live="${RESTORE_LIVE_DATABASE:-marathon_trips}"
if [ "$db" = "$live" ] && [ "$live_ok" != yes ]; then die "$db is the live database; restore into a new name first (see docs/deploy/guide.md)"; fi

# Existing targets are refused before anything is touched.
exists="$(psql -X -q -A -t -d postgres -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname = '$db'")"
if [ -n "$exists" ] && [ "$replace" != yes ]; then die "database $db already exists; pick a new name or add --replace"; fi
if [ -d "$files_dir" ] && [ -n "$(ls -A "$files_dir")" ] && [ "$replace" != yes ]; then die "$files_dir is not empty; pick another directory or add --replace"; fi

work="$(mktemp -d "${RESTORE_WORK_DIR:-${TMPDIR:-/tmp}}/mt-restore.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# 1. The bundle itself: sidecar checksum when it sits next to it, then decrypt.
side="$bundle.sha256"
if [ -f "$side" ]; then
  want="$(cut -d' ' -f1 "$side")"
  [ "$(sha256_of "$bundle")" = "$want" ] || die "the bundle does not match its .sha256 file (damaged or altered)"
fi
case "$bundle" in
  *.enc) : "${BACKUP_PASSPHRASE_FILE:?this bundle is encrypted; set BACKUP_PASSPHRASE_FILE}"; decrypt_to "$bundle" "$work/bundle.tar" "$BACKUP_PASSPHRASE_FILE" ;;
  *) cp "$bundle" "$work/bundle.tar" ;;
esac
tar --extract --file="$work/bundle.tar" --directory="$work" db.dump files.tar MANIFEST 2>/dev/null || die "the bundle is not a Marathon Trips backup (or is damaged)"
[ "$(manifest_value "$work/MANIFEST" format)" = 1 ] || die "unknown bundle format"

# 2. The parts against the MANIFEST.
[ "$(sha256_of "$work/db.dump")" = "$(manifest_value "$work/MANIFEST" db_dump_sha256)" ] || die "db.dump does not match MANIFEST"
[ "$(sha256_of "$work/files.tar")" = "$(manifest_value "$work/MANIFEST" files_tar_sha256)" ] || die "files.tar does not match MANIFEST"

# 3. Database: create (or replace), restore with owners and grants, then the database-level access rules that
#    pg_dump does not carry (same as docker/db/init/01-roles.sql).
if [ -n "$exists" ]; then psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE \"$db\" WITH (FORCE)"; fi
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE \"$db\" OWNER mt_owner"
psql -X -q -v ON_ERROR_STOP=1 -d postgres <<SQL
REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
GRANT CONNECT ON DATABASE "$db" TO mt_app, mt_owner;
REVOKE CREATE, TEMPORARY ON DATABASE "$db" FROM mt_app;
SQL
pg_restore --dbname="$db" --exit-on-error --no-password "$work/db.dump" || die "pg_restore failed; $db was left for inspection"

# 4. Files.
if [ -d "$files_dir" ] && [ "$replace" = yes ]; then find "$files_dir" -mindepth 1 -delete; fi
mkdir -p "$files_dir"
tar --extract --file="$work/files.tar" --directory="$files_dir" || die "could not extract files into $files_dir"

# 5. Proof: exact row counts of the restored database equal the counts taken in the backup's snapshot.
manifest_counts "$work/MANIFEST" > "$work/expected.txt"
db_counts "$db" > "$work/actual.txt"
if ! diff -u "$work/expected.txt" "$work/actual.txt" > "$work/diff.txt"; then
  cat "$work/diff.txt" >&2
  die "row counts differ from MANIFEST; the restore is NOT good"
fi
tables="$(wc -l < "$work/actual.txt" | tr -d ' ')"
nfiles="$(find "$files_dir" -type f | wc -l | tr -d ' ')"
log "restore ok: database $db ($tables tables, row counts match), $nfiles files in $files_dir"
