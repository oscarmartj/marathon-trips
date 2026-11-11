#!/usr/bin/env bash
# The routine restore check (docs/deploy/guide.md): restores a bundle into a throw-away database and directory, compares
# it with the MANIFEST, then removes both. Run it monthly and after any change to the backup set-up.
#   (VERIFY_DB_PREFIX changes the throw-away database name prefix; default mt_verify)
#   PGHOST=... PGUSER=postgres PGPASSWORD=... [BACKUP_PASSPHRASE_FILE=...] bash scripts/backup/verify-restore.sh <bundle>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
[ $# -eq 1 ] || die "usage: verify-restore.sh <bundle>"
db="${VERIFY_DB_PREFIX:-mt_verify}_$(date -u +%Y%m%d%H%M%S)_$$"
dir="$(mktemp -d "${TMPDIR:-/tmp}/mt-verify-files.XXXXXX")"
status=0
bash "$here/restore.sh" "$1" --database "$db" --files-dir "$dir" --replace || status=$?
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || log "could not drop $db; drop it by hand"
rm -rf "$dir"
[ "$status" -eq 0 ] && log "verify-restore: ok" || log "verify-restore: FAILED"
exit "$status"
