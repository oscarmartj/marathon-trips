#!/usr/bin/env bash
# Takes one consistent backup of the database and the uploaded files (task 8.6, docs/deploy/guide.md "Copias de seguridad").
#
#   BACKUP_DIR=/backups FILES_DIR=/data/files PGHOST=db PGUSER=mt_owner PGDATABASE=marathon_trips PGPASSWORD=... \
#   BACKUP_PASSPHRASE_FILE=/run/secrets/backup_passphrase BACKUP_REMOTE_KIND=rclone BACKUP_REMOTE_TARGET=b2:example-bucket/marathon-trips \
#   bash scripts/backup/backup.sh
#
# Required: BACKUP_DIR, FILES_DIR, and the libpq variables. Optional:
#   BACKUP_PASSPHRASE_FILE   encrypt the bundle (AES-256, passphrase read from this file, never from the command line)
#   BACKUP_REMOTE_KIND       none (default) | dir | rclone. The off-server copy; see below
#   BACKUP_REMOTE_TARGET     dir: a mounted directory. rclone: remote:path, with the remote set up in rclone's own configuration
#   BACKUP_ALLOW_LOCAL_ONLY  yes = a backup with no off-server copy is acceptable (development and tests only)
#   BACKUP_ALLOW_UNENCRYPTED yes = acceptable without a passphrase when APP_ENV=production
#   BACKUP_KEEP              how many bundles to keep in BACKUP_DIR (default 14)
# Exit status 0 only when the bundle is complete, written, and copied off the server when a copy is required.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${FILES_DIR:?FILES_DIR is required}"
kind="${BACKUP_REMOTE_KIND:-none}"
keep="${BACKUP_KEEP:-14}"
pass="${BACKUP_PASSPHRASE_FILE:-}"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_KEEP must be a positive integer"
for t in psql pg_dump tar sha256sum; do need "$t"; done
[ -d "$FILES_DIR" ] || die "FILES_DIR $FILES_DIR is not a directory"
case "$kind" in
  none) [ "${BACKUP_ALLOW_LOCAL_ONLY:-}" = yes ] || die "BACKUP_REMOTE_KIND=none keeps the backup on the same server; set BACKUP_REMOTE_KIND=rclone (or dir), or BACKUP_ALLOW_LOCAL_ONLY=yes to accept the risk" ;;
  dir) [ -n "${BACKUP_REMOTE_TARGET:-}" ] && [ -d "$BACKUP_REMOTE_TARGET" ] || die "BACKUP_REMOTE_TARGET must be an existing directory for kind dir" ;;
  rclone) need rclone; [ -n "${BACKUP_REMOTE_TARGET:-}" ] || die "BACKUP_REMOTE_TARGET (remote:path) is required for kind rclone" ;;
  *) die "BACKUP_REMOTE_KIND must be none, dir or rclone" ;;
esac
if [ -n "$pass" ]; then need openssl; [ -r "$pass" ] || die "BACKUP_PASSPHRASE_FILE is not readable"
elif [ "${APP_ENV:-}" = production ] && [ "${BACKUP_ALLOW_UNENCRYPTED:-}" != yes ]; then
  die "the bundle holds personal data: set BACKUP_PASSPHRASE_FILE (or BACKUP_ALLOW_UNENCRYPTED=yes)"
fi
mkdir -p "$BACKUP_DIR"

work="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
ts="$(date -u +%Y%m%dT%H%M%SZ)"
name="mt-backup-$ts"

# One psql session holds a REPEATABLE READ snapshot open while the counts are taken and pg_dump runs against the same
# snapshot, so the counts in MANIFEST describe exactly the data in the dump even while the site is taking writes.
coproc PSQL { psql -X -q -A -t -v ON_ERROR_STOP=1 -d "${PGDATABASE:-postgres}" 2>&1; }
SENTINEL="__mt_done_$$"
ANSWER=""
ask() { # run SQL in the session; the answer lines go to $ANSWER (no command substitution: subshells cannot use the coproc)
  ANSWER=""
  printf '%s\n' "$1" >&"${PSQL[1]}" || die "the database session ended early"
  printf "SELECT '%s';\n" "$SENTINEL" >&"${PSQL[1]}" || die "the database session ended early"
  local line
  while IFS= read -r -u "${PSQL[0]}" line; do
    if [ "$line" = "$SENTINEL" ]; then return 0; fi
    ANSWER+="$line"$'\n'
  done
  die "the database session ended early: ${ANSWER:-no output}"
}
ask "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
ask "SELECT pg_export_snapshot();"
snapshot="${ANSWER//[$'\n']/}"
[[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "could not export a snapshot: $snapshot"
ask "$(counts_sql | tr '\n' ' ')"
ask "${ANSWER//[$'\n']/ };"
counts="$(printf '%s' "$ANSWER" | LC_ALL=C sort)"
[ -n "$counts" ] || die "no table counts; is this the right database?"
pg_dump --format=custom --snapshot="$snapshot" --no-password --file="$work/db.dump" || die "pg_dump failed"
printf 'COMMIT;\n\\q\n' >&"${PSQL[1]}" || true
wait "$PSQL_PID" 2>/dev/null || true

# Files after the dump: a file a dumped row points to is already stored (files are written once and never changed).
tar --create --file="$work/files.tar" --directory="$FILES_DIR" . || die "could not archive $FILES_DIR"

{
  echo "format=1"
  echo "created=$ts"
  echo "database=${PGDATABASE:-postgres}"
  echo "server_version=$(psql -X -q -A -t -d "${PGDATABASE:-postgres}" -c 'SHOW server_version')"
  echo "db_dump_sha256=$(sha256_of "$work/db.dump")"
  echo "files_tar_sha256=$(sha256_of "$work/files.tar")"
  echo "[counts]"
  printf '%s\n' "$counts"
} > "$work/MANIFEST"

tar --create --file="$work/bundle.tar" --directory="$work" db.dump files.tar MANIFEST
if [ -n "$pass" ]; then
  final="$name.tar.enc"
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$pass" -in "$work/bundle.tar" -out "$work/$final" || die "encryption failed"
  encrypted=true
else
  final="$name.tar"
  mv "$work/bundle.tar" "$work/$final"
  encrypted=false
fi
sha="$(sha256_of "$work/$final")"
bytes="$(stat -c %s "$work/$final")"
printf '%s  %s\n' "$sha" "$final" > "$work/$final.sha256"
# Written under a temporary name and renamed: a half-written bundle never looks complete.
mv "$work/$final" "$BACKUP_DIR/$final"
mv "$work/$final.sha256" "$BACKUP_DIR/$final.sha256"

offsite=false
case "$kind" in
  dir)
    for f in "$final" "$final.sha256"; do cp "$BACKUP_DIR/$f" "$BACKUP_REMOTE_TARGET/.$f.part" && mv "$BACKUP_REMOTE_TARGET/.$f.part" "$BACKUP_REMOTE_TARGET/$f"; done || die "copy to $BACKUP_REMOTE_TARGET failed"
    offsite=true ;;
  rclone)
    for f in "$final" "$final.sha256"; do rclone copyto "$BACKUP_DIR/$f" "$BACKUP_REMOTE_TARGET/$f" || die "rclone copy to the off-server store failed; the bundle is in $BACKUP_DIR"; done
    offsite=true ;;
esac

# Keep the newest $keep bundles here (the off-server store has its own lifecycle rule).
mapfile -t old < <(cd "$BACKUP_DIR" && ls -1 mt-backup-*.tar mt-backup-*.tar.enc 2>/dev/null | sort -r | tail -n +"$((keep + 1))")
for f in "${old[@]}"; do [ -n "$f" ] && rm -f "$BACKUP_DIR/$f" "$BACKUP_DIR/$f.sha256"; done

# Status for the system monitor, written last and atomically: it only exists when everything above worked.
printf '{"finishedAt":"%s","bundle":"%s","sha256":"%s","bytes":%s,"offsite":%s,"encrypted":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$final" "$sha" "$bytes" "$offsite" "$encrypted" > "$BACKUP_DIR/.last-backup.json.part"
mv "$BACKUP_DIR/.last-backup.json.part" "$BACKUP_DIR/last-backup.json"
log "ok: $final ($bytes bytes, offsite=$offsite, encrypted=$encrypted)"
