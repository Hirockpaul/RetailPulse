#!/usr/bin/env bash
# npm run db:restore -- <backup.dump> [--target=<new database>]
# Restores a backup ONLY into a new database, never over an existing one (V2 5e):
#   1. refuses an existing target and the live database; checks the dump's SHA-256 first;
#   2. ensures the cluster-wide reporting role exists (roles are not part of a database dump);
#   3. creates the database and restores in one transaction (dropped again if that fails);
#   4. runs the integrity check and compares row counts with the backup's manifest.
# Pointing the application at the restored database is a separate, manual step.
source "$(dirname "$0")/lib.sh"

dump="${1:-}"
[[ -n "$dump" && -f "$dump" ]] || { echo "Usage: npm run db:restore -- <backup.dump> [--target=<new database>]" >&2; exit 2; }
target="retailpulse_restore_$(date -u +%Y%m%d_%H%M%S)"
for arg in "${@:2}"; do [[ "$arg" == --target=* ]] && target="${arg#--target=}"; done

[[ "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "Refusing: \"$target\" is not a plain database name (a-z, 0-9, _)." >&2; exit 2; }
[[ "$target" != "$LIVE_DB" ]] || { echo "Refusing: \"$target\" is the live database. Restores only go into a new one." >&2; exit 2; }
if [[ "$(pg_sql postgres "SELECT count(*) FROM pg_database WHERE datname = '$target'")" != "0" ]]; then
  echo "Refusing: database \"$target\" already exists. Choose a new name with --target=…" >&2; exit 2
fi

manifest="${dump%.dump}.manifest.json"
[[ -f "$manifest" ]] || { echo "Refusing: no manifest next to the dump ($manifest)." >&2; exit 2; }
expected=$(node -e 'console.log(require(process.argv[1]).sha256)' "$(realpath "$manifest")")
actual=$(sha256sum "$dump" | cut -d' ' -f1)
[[ "$expected" == "$actual" ]] || { echo "Refusing: the dump's SHA-256 does not match its manifest (changed or damaged)." >&2; exit 2; }
echo "Checksum OK. Restoring into new database \"$target\"…"

pg_sql postgres "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'retailpulse_grafana') THEN
    CREATE ROLE retailpulse_grafana NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF; END \$\$" >/dev/null
pg_sql postgres "CREATE DATABASE \"$target\"" >/dev/null

started=$(date +%s%N)
if ! pg_tool pg_restore -d "$target" --no-owner --exit-on-error --single-transaction < "$dump"; then
  pg_sql postgres "DROP DATABASE IF EXISTS \"$target\"" >/dev/null
  echo "Restore failed; the new database \"$target\" was removed again. Nothing else was changed." >&2
  exit 1
fi
restore_ms=$(ms_since "$started")
echo "Restored in ${restore_ms} ms. Checking integrity…"

started=$(date +%s%N)
set +e
result=$(verify --db="$target" --json)
verify_status=$?
set -e
verify_ms=$(ms_since "$started")
node -e '
const [result, manifestFile, verifyMs] = process.argv.slice(1);
const r = JSON.parse(result), m = require(manifestFile);
for (const c of r.results) console.log(`  ${c.status.padEnd(4)}  ${c.name} — ${c.detail}`);
const diffs = Object.entries(m.rowCounts).filter(([k, v]) => r.counts[k] !== v);
console.log(diffs.length === 0
  ? `  PASS  row counts equal the backup manifest (${Object.keys(m.rowCounts).length} tables)`
  : `  WARN  row counts differ from the manifest: ${diffs.map(([k, v]) => `${k} ${v} → ${r.counts[k]}`).join(", ")} (writes between the dump and the manifest count)`);
console.log(`Integrity check in ${verifyMs} ms.`);
' "$result" "$(realpath "$manifest")" "$verify_ms"

if [[ $verify_status -ne 0 ]]; then
  echo "The restored database \"$target\" FAILED the integrity check — do not use it." >&2
  exit 1
fi
cat <<MSG
Restored database "$target" is ready and was not connected to anything.
To use it, stop the API, set POSTGRES_DB=$target (and DATABASE_URL) in .env, and start the API again.
MSG
