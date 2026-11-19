# Shared helpers for backup.sh / restore.sh (V2 5e). Sourced, not run.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [[ -f .env ]]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is not set (copy .env.example to .env)}"

# Parts of DATABASE_URL (node is always available in this repo).
mapfile -t _url < <(node -e '
const u = new URL(process.env.DATABASE_URL);
for (const v of [decodeURIComponent(u.username), u.pathname.slice(1), u.hostname, u.port || 5432,
  decodeURIComponent(u.password)]) console.log(v);')
PGUSER_="${_url[0]}"; LIVE_DB="${_url[1]}"; PGHOST_="${_url[2]}"; PGPORT_="${_url[3]}"; PGPASSWORD_="${_url[4]}"

# The integrity check (read-only). Called directly: `npm run` would print its own header lines.
verify() { node services/api/scripts/verify.mjs "$@"; }

server_major() { pg_sql postgres "SHOW server_version_num" | cut -c1-2; }

# Run a PostgreSQL client tool: the host's when its major version matches the server, otherwise the
# one in the `postgres` Compose container (same version as the server by construction).
pg_tool() {
  local tool="$1"; shift
  if command -v "$tool" >/dev/null 2>&1 && [[ -n "${PG_HOST_OK:-}" ]]; then
    PGHOST="$PGHOST_" PGPORT="$PGPORT_" PGUSER="$PGUSER_" PGPASSWORD="$PGPASSWORD_" "$tool" "$@"
  else
    docker compose exec -T postgres "$tool" -U "$PGUSER_" "$@"
  fi
}

# One SQL statement, unaligned output, against database $1.
pg_sql() { local db="$1"; shift; docker compose exec -T postgres psql -X -q -At -U "$PGUSER_" -d "$db" -v ON_ERROR_STOP=1 -c "$1"; }

if command -v pg_dump >/dev/null 2>&1; then
  host_major=$(pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')
  [[ "$host_major" == "$(server_major)" ]] && PG_HOST_OK=1 || true
fi

ms_since() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
