# RetailPulse — Intelligent Inventory Management

RetailPulse is an inventory management platform for a **simulated** multi-store retailer.
It tracks stock across stores and distribution centres, records every stock movement in an
append-only ledger, forecasts demand, and suggests replenishment that a manager must approve.

> **All data is synthetic.** RetailPulse is an independent portfolio/learning project and is not
> connected to, endorsed by, or based on any real retailer's systems or data.

## What it answers

- How many units are **on hand, reserved, available, inbound** at each location?
- What stock movements happened, and **why**? (ledger)
- Which products are **at risk of running out**?
- How much will each store **need** over the coming days?
- Should a manager **transfer** stock or **reorder** from a supplier — and on what inputs?
- How **accurate** are the forecasts?

## Stack

| Area                | Technology                                     | Status    |
| ------------------- | ---------------------------------------------- | --------- |
| Web interface       | React, TypeScript, Vite, Tailwind CSS          | Day 1 ✅  |
| Core API            | Node.js, NestJS, TypeScript                    | Day 1 ✅  |
| Database            | PostgreSQL 17 (plain SQL migrations)           | Day 1 ✅  |
| Forecasting service | Python, FastAPI, Pandas, NumPy, scikit-learn   | Day 6 ✅  |
| Events              | PostgreSQL outbox + in-API worker (no Kafka)   | Day 5 ✅  |
| Metrics             | Prometheus + Grafana (optional compose profile)| Day 7 ✅  |
| Local infra         | Docker Compose (Postgres; full demo profile)   | Day 7 ✅  |
| End-to-end test     | Playwright (one happy path)                    | Day 7 ✅  |

Redis and Superset from the original idea are **deferred** until a concrete need appears
(see `AGENT.md` → "Keep it simple").

## Architecture (short version)

```text
 React web (5173) ──/api/v1──▶ NestJS API (3000) ──SQL──▶ PostgreSQL (source of truth)
                                   │    ▲                     │
                                   │    └── HTTP ── FastAPI forecasting (8000)
                                   │                          │ (reads sales history)
                                   └── outbox (same transaction) ──▶ worker ──▶ alerts
```

- **Modular monolith** API: one NestJS app, one module per domain (catalog, inventory, orders…).
- **Every stock change** goes through one inventory service: one DB transaction writes the
  ledger entry, updates the balance (row-locked), and writes an outbox event.
- **Forecasts are advisory.** They never mutate inventory or place orders.

Full design (data model, write path, events, module rules, decision log):
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Repository layout

```text
RetailPulse/
├── apps/web/src/
│   ├── api/                  fetch client + typed API calls
│   ├── components/           shared UI pieces
│   └── pages/                one component per screen (Overview is the landing page)
├── apps/web/e2e/             Playwright happy path
├── services/api/
│   ├── migrations/           Plain SQL migrations (0001_*.sql, 0002_*.sql …)
│   ├── scripts/migrate.mjs   Tiny migration runner (checksums + advisory lock)
│   └── src/
│       ├── core/             config, database, http (no business logic)
│       └── modules/          one folder per domain: health, catalog, inventory, …
├── services/forecasting/     FastAPI forecasting service
├── docs/ARCHITECTURE.md      System design
├── .github/workflows/ci.yml  Lint, typecheck, test, migrate
├── docker-compose.yml        PostgreSQL; profiles `full` (whole app) and `observability`
├── ops/observability/        Prometheus config + Grafana dashboard
├── scripts/simulation/       POS simulator, `npm run demo`, `npm run measure`
├── .env.example
├── AGENT.md                  Rules + 7-day build plan for AI coding agents
└── README.md
```

## Run the whole demo in Docker (fastest)

Requirements: Docker with Compose. From a fresh clone:

```bash
cp .env.example .env
```

```bash
docker compose --profile full up --build -d --wait
```

That builds three images, migrates and seeds the database with **synthetic** data, generates
12 months of synthetic sales history, and starts the API, the forecasting service and the web
app. Open **http://localhost:8080** and sign in as `inventory@retailpulse.test` with the
`DEMO_PASSWORD` from your `.env`. The first build takes a few minutes (2.5 min measured on a laptop).

Then, in the app: **Replenishment → Refresh forecasts** (about 30 s), and start at **Overview**.
To also simulate shop traffic and fill in alerts and recommendations from the command line
(needs Node; uses the API on port 3000 like any client):

```bash
npm install && npm run demo
```

Stop it with `docker compose --profile full down` (add `-v` to also delete the database volume).
The full profile uses the same PostgreSQL container and volume as local development, and ports
3000 and 8080: stop `npm run dev:api` first.

**Metrics (optional):** Prometheus on http://localhost:9090 and Grafana on http://localhost:3001
(dashboard *RetailPulse API*: requests, p95 latency, errors, outbox backlog; anonymous read-only):

```bash
docker compose --profile full --profile observability up -d --wait
```

## Quick start for development (WSL2 / Linux)

Requirements: Node 20+ (tested on 24), Python 3.12, Docker with Compose.

```bash
cp .env.example .env
```

```bash
npm install
```

```bash
npm run db:up
```

```bash
npm run db:migrate
```

Load the synthetic demo data (5 stores, 2 DCs, 200 products, 3 suppliers). Safe to re-run;
add `-- --reset` to wipe and recreate it:

```bash
npm run db:seed
```

```bash
npm run dev:api
```

In a second terminal:

```bash
npm run dev:web
```

Open http://localhost:5173 and sign in with one of the **synthetic demo accounts** (created by
`npm run db:seed`; the shared password is `DEMO_PASSWORD` in your `.env`):

| Account (all `@retailpulse.test`) | Role | What it can do |
| --- | --- | --- |
| `admin@` | Admin | Everything |
| `inventory@` | Inventory manager | Everything on stock; approves transfers |
| `store1@` | Store manager, STR-01 | Own store only; requests transfers into it |
| `store2@` | Store manager, STR-02 | Own store only |
| `analyst@` | Analyst | Read-only |

Then use Products, Stock (per location), product detail (record sales, receipts, returns,
adjustments and reservations, and watch the ledger update), Transfers (request, approve,
dispatch, receive), **Alerts** (raised automatically after stock movements; admins and inventory
managers can press *Re-scan stock* once after seeding) and Health (event worker status).

Generate synthetic POS traffic against the running API (it signs in as the synthetic inventory
manager; stock falls, some sales are rejected for no stock — that is expected):

```bash
npm run sim:pos -- --sales=100 --concurrency=4
```

Simulate unusual stock activity (one large write-off, repeated small corrections, many returns —
all through the API) to see findings on the **Unusual activity** page:

```bash
npm run sim:suspicious
```

Or do the whole demo setup at once — migrate, seed, POS traffic, alert re-scan and, if the
forecasting service is running, a forecast plus recommendations (all through the API):

```bash
npm run demo
```

> **Security note:** every API route needs a session and an allowed role (see
> [Roles and access](docs/ARCHITECTURE.md#roles-and-access)). The demo accounts and their shared
> password are for local use only. Failed logins are rate-limited per email and IP.

### Forecasting and replenishment (Day 6)

One-time setup of the Python environment:

```bash
cd services/forecasting && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
```

Generate 12 months of **synthetic** daily sales history for every product and store (fictional data;
safe to re-run, real sales are never overwritten):

```bash
npm run forecast:history
```

Start the forecasting service (internal, no login, port 8000 — keep it on localhost):

```bash
npm run forecast:serve
```

Then sign in as an admin or inventory manager and open **Replenishment → Refresh forecasts**
(about 30 seconds). It shows how accurate each model is, and lists recommendations that you can
approve or reject. Suggestions can transfer stock from a DC, use another store's excess, order from
a supplier, or return remaining excess to a DC. Approving creates the transfer or purchase order;
stock moves only when those are dispatched/received. A forecast never moves or orders anything by
itself.

```bash
npm run forecast:test
```

Re-measure forecast accuracy (rebuilds the dev history in memory, compares feature sets,
prints WAPE, bias, range coverage and the noise floor; writes nothing, ~2 minutes):

```bash
npm run forecast:measure
```

Compare other model types against the production model on the same protocol (V2 step 1d; ~3 minutes):

```bash
npm run forecast:measure -- --candidates
```

Score unusual-sales detection against the injected labels on three datasets (V2 step 1e-1; ~2 minutes):

```bash
npm run forecast:measure -- --anomalies
```

### Useful endpoints

| URL                                   | What                                  |
| ------------------------------------- | ------------------------------------- |
| `GET http://localhost:3000/api/v1/health` | API + database status (503 if DB down) |
| `GET http://localhost:3000/api/v1/products?q=milk&sort=price:desc` | Search/sort/paginate products |
| `GET http://localhost:3000/api/v1/locations/{id}/stock` | Stock at one location |
| `GET http://localhost:3000/api/v1/products/{id}/ledger` | Every stock movement for a product |
| `POST http://localhost:3000/api/v1/sales` | Record a sale (needs an `Idempotency-Key` header) |
| `GET http://localhost:8000/health`    | Forecasting service status            |
| `POST http://localhost:3000/api/v1/forecasts/run` | Start a forecast run (admin / inventory manager) |
| `GET http://localhost:3000/api/v1/replenishment/recommendations` | Suggested transfers and orders |
| `GET http://localhost:3000/api/v1/overview` | Landing-page summary: stock-outs, at risk, excess, freshness |
| `GET http://localhost:3000/metrics` | Prometheus metrics (outside `/api/v1`; not proxied by the web container) |

All endpoints: [docs/ARCHITECTURE.md §5](docs/ARCHITECTURE.md#5-api-conventions).

## Quality checks

```bash
npm run check
```

Runs format check, lint, typecheck, unit tests and build for the TypeScript apps.

Integration tests (real PostgreSQL; every test file gets its own temporary database, created and dropped
automatically, so your dev data is never touched and two runs can safely overlap):

```bash
npm run test:int
```

Python:

```bash
cd services/forecasting && .venv/bin/ruff check . && .venv/bin/pytest
```

End-to-end (Playwright, one happy path: sign in → Overview → receive and sell stock → transfer
from a DC to a store through every step). It builds the API, creates its own `<db>_e2e`
database and runs on ports 3100/5174, so it does not disturb your dev servers or data.
One-time browser download, then the test:

```bash
npx playwright install --only-shell chromium
```

```bash
npm run test:e2e
```

## A five-minute walkthrough

1. **Overview** (landing page): how many product × store positions are out of stock now, which
   will run out within 7 days (available + inbound below the forecast), surplus stock (> 60 days of
   cover), pending recommendations, and *how fresh each number is* (last movement, forecast run
   and its history end, last processed event).
2. Click a product in “Soonest to run out” → **product page**: stock per location, the forecast
   chart with its 80 % range, and the **ledger** explaining every unit.
3. **Replenishment** → open a recommendation: the “why” panel shows every input (forecast and its
   typical error, lead time and how reliable the supplier is, the service level from the product's
   ABC/XYZ class, safety stock, reorder point, position, pack rounding, source) and the expected
   stockout date. Items marked **Needs review** (little sales history, or erratic demand) are
   approved with a quantity and a note you enter; the product page shows, per store, whether
   anything is needed now (“No action required” is computed live, not stored). Approve it: an approved transfer or
   purchase order is created — nothing moves yet.
4. **Transfers** → dispatch and receive it: two ledger rows (`TRANSFER_OUT`, `TRANSFER_IN`), and
   the alert for that store resolves on its own (event worker).
5. **Unusual activity** lists sales spikes and stops (found by each forecast run) and unusual
   write-offs, adjustments and returns (found after stock movements), high first, each with the
   numbers behind it and how much to trust it. Open one, investigate, confirm or dismiss with a
   note; the history records who decided what. Reviewing never changes stock.
6. **ABC/XYZ** shows which products carry the value and how predictable their demand is, as a
   3 × 3 matrix for the whole network or one store; click a cell for its products and the
   suggested stocking policy.
7. **Suppliers** shows how reliably each supplier delivers (on time, in full, lead-time spread)
   with a score, per product and the latest deliveries; history is synthetic until real purchase
   orders are received.
8. **Health** shows the event worker; Grafana (optional) shows latency and the outbox backlog.

## Measured numbers

Measured on one laptop (WSL2, 16 logical CPUs, 3.5 GB RAM given to Linux) with the seeded synthetic data
(200 products × 7 locations), the API running in its production Docker image. Reproduce with
`npm run measure` and `npm run sim:pos`. These are local measurements, not benchmark claims.

| What | Result |
| ---- | ------ |
| Read latency, 200 sequential requests each (products search, stock, ledger, alerts, recommendations) | p95 **6–10 ms** |
| `GET /overview` (classifies all 1,000 product × store positions) | p50 19 ms, p95 **24 ms** |
| 500 simulated POS sales, 8 at a time | **2.4 s** (≈ 200 sales/s), 0 unexpected errors |
| Forecast run, 1,000 series (3 models + backtest) | 35–40 s |
| Forecast accuracy (test window, WAPE) | gradient boosting 51.6 %, best baseline 54.4 %, noise floor 51.0 % (`npm run forecast:measure`); 80 % / 95 % ranges held 80.0 % / 94.9 % — see [ARCHITECTURE §7.3](docs/ARCHITECTURE.md#73-measured-accuracy-synthetic-data--not-a-claim-about-real-retail) |
| Memory of the running demo | API ≈ 45–95 MB, forecasting ≈ 195 MB, Postgres ≈ 160 MB, web ≈ 15 MB |
| Image sizes | API 288 MB, web 82 MB, forecasting 744 MB |
| Tests | 183 unit/HTTP + 231 integration (TypeScript), 94 Python, 2 end-to-end |

## Known limitations

- **Synthetic data only.** Forecast accuracy is measured on generated sales; it says nothing about
  real retail demand. Demand is not corrected for stock-outs.
- **Single instance.** The login rate limit is in memory; the event worker and housekeeping are
  safe with several instances, but this was only tested with one API process.
- **Local demo, not a deployment.** Ports are bound to `127.0.0.1`; the forecasting service has no
  login and is only reachable inside the compose network; `/metrics` is unauthenticated (counts and
  latencies only); Grafana allows anonymous read-only viewing. The session cookie is `Secure` in the
  container, which browsers accept on `http://localhost` only.
- **Retention.** Processed outbox events and idempotency keys are deleted after 7 days (a retry
  with the same key after that counts as a new request). Dead letters are kept until replayed.
- **Not built:** a generated OpenAPI page (the endpoint table in ARCHITECTURE §5 is the
  reference), manual purchase orders, partial transfer deliveries, Redis/Superset, hosting.

## Principles

- PostgreSQL is the source of truth for inventory.
- Never change stock with an untraceable direct edit — every change is a ledger entry.
- ML never places orders or mutates inventory; a manager approves every replenishment.
- Measure performance and accuracy; don't invent benchmark claims.
- Keep the local environment light: only PostgreSQL starts by default.

## Build plan

The project is built in 7 days (A = build, B = verify). See [AGENT.md](AGENT.md#7-seven-day-build-plan).
