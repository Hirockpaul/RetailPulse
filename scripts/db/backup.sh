#!/usr/bin/env bash
# npm run db:backup — dump the live database to backups/ with a manifest (V2 5e).
#   backups/retailpulse-<UTC>.dump            PostgreSQL custom format (compressed, all schemas)
#   backups/retailpulse-<UTC>.manifest.json   source, versions, SHA-256, size, migration, row counts
# Read-only for the database. Rules: docs/V2-PLAN.md step 5e.
source "$(dirname "$0")/lib.sh"

mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="backups/retailpulse-$stamp.dump"
manifest="backups/retailpulse-$stamp.manifest.json"

started=$(date +%s%N)
pg_tool pg_dump -d "$LIVE_DB" --format=custom --compress=6 > "$dump.partial"
mv "$dump.partial" "$dump"
dump_ms=$(ms_since "$started")

sha=$(sha256sum "$dump" | cut -d' ' -f1)
size=$(stat -c %s "$dump")
server=$(pg_sql "$LIVE_DB" "SHOW server_version")
if [[ -n "${PG_HOST_OK:-}" ]]; then pgdump=$(pg_dump --version); else pgdump=$(docker compose exec -T postgres pg_dump --version); fi
last_migration=$(pg_sql "$LIVE_DB" "SELECT max(name) FROM schema_migrations")
# Row counts right after the dump (a busy database may differ by the writes in between).
# A backup is taken even when the check fails (that is when one is wanted most).
counts=$( (verify --db="$LIVE_DB" --json || true) | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({ok:r.ok,counts:r.counts}))})')

node -e '
const [file, db, stamp, sha, size, server, pgdump, last, counts, ms] = process.argv.slice(1);
const c = JSON.parse(counts);
require("node:fs").writeFileSync(file, JSON.stringify({
  createdAt: new Date().toISOString(), stamp, sourceDatabase: db, serverVersion: server,
  pgDump: pgdump, format: "custom", sha256: sha, bytes: Number(size), lastMigration: last,
  integrityCheckPassed: c.ok, rowCounts: c.counts, dumpMs: Number(ms),
  note: "Row counts were taken right after the dump; on a busy database they can differ by the writes in between.",
}, null, 2) + "\n");
' "$manifest" "$LIVE_DB" "$stamp" "$sha" "$size" "$server" "$pgdump" "$last_migration" "$counts" "$dump_ms"

echo "Backup of \"$LIVE_DB\" written in $((dump_ms)) ms:"
echo "  $dump  ($(numfmt --to=iec "$size"), sha256 ${sha:0:16}…)"
echo "  $manifest"
echo "Restore it into a NEW database with: npm run db:restore -- $dump"
