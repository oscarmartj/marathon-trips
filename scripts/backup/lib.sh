# Shared helpers for backup.sh, restore.sh and verify-restore.sh (task 8.6). Sourced, not run.
# Connection settings come from the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).

die() { echo "backup: $*" >&2; exit 1; }
log() { echo "backup: $*" >&2; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

# SQL that lists "schema.table=rows" for every top-level table of the application and job schemas, one line per table.
# Counted with exact count(*), in whatever snapshot or database the caller runs it.
counts_sql() {
  cat <<'SQL'
SELECT coalesce(
  'SELECT t || ''='' || n FROM (' ||
  string_agg(format('SELECT %L AS t, count(*) AS n FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname), ' UNION ALL ' ORDER BY n.nspname, c.relname) ||
  ') x ORDER BY t',
  'SELECT NULL WHERE false')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname IN ('public', 'pgboss');
SQL
}

# Row counts of the database named in $1, as sorted "schema.table=rows" lines.
db_counts() {
  local db="$1" query
  query="$(counts_sql | psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$db")" || return 1
  printf '%s\n' "$query" | psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$db" | LC_ALL=C sort
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

manifest_value() { grep -m1 "^$2=" "$1" | cut -d= -f2-; }

# Lines after [counts] in a MANIFEST file.
manifest_counts() { sed -n '/^\[counts\]$/,$p' "$1" | tail -n +2 | LC_ALL=C sort; }

decrypt_to() { # <in.enc> <out> <passphrase-file>
  [ -r "$3" ] || die "passphrase file $3 is not readable"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$3" -in "$1" -out "$2" 2>/dev/null || die "cannot decrypt $1 (wrong passphrase or damaged file)"
}
