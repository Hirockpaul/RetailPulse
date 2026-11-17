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
| Forecasting service | Python, FastAPI, Pandas, NumPy, scikit-learn   | Day 1 ✅  |
| Events              | PostgreSQL outbox + in-API worker (no Kafka)   | Day 5 ✅  |
| Metrics             | Prometheus + Grafana (optional compose profile)| Day 7     |
| Local infra         | Docker Compose                                 | Day 1 ✅  |

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
│   └── pages/                one component per screen
├── services/api/
│   ├── migrations/           Plain SQL migrations (0001_*.sql, 0002_*.sql …)
│   ├── scripts/migrate.mjs   Tiny migration runner (checksums + advisory lock)
│   └── src/
│       ├── core/             config, database, http (no business logic)
│       └── modules/          one folder per domain: health, catalog, inventory, …
├── services/forecasting/     FastAPI forecasting service
├── docs/ARCHITECTURE.md      System design
├── .github/workflows/ci.yml  Lint, typecheck, test, migrate
├── docker-compose.yml        PostgreSQL (more services added as optional profiles)
├── .env.example
├── AGENT.md                  Rules + 7-day build plan for AI coding agents
└── README.md
```

## Quick start (WSL2 / Linux)

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

Generate synthetic POS traffic against the running API (stock falls, some sales are rejected
for no stock — that is expected):

```bash
npm run sim:pos -- --sales=100 --concurrency=4
```

> **Security note:** every API route needs a session and an allowed role (see
> [Roles and access](docs/ARCHITECTURE.md#roles-and-access)). The demo accounts and their shared
> password are for local use only. Failed logins are rate-limited per email and IP.

Forecasting service:

```bash
cd services/forecasting && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
```

```bash
cd services/forecasting && .venv/bin/uvicorn app.main:app --reload --port 8000
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

## Principles

- PostgreSQL is the source of truth for inventory.
- Never change stock with an untraceable direct edit — every change is a ledger entry.
- ML never places orders or mutates inventory; a manager approves every replenishment.
- Measure performance and accuracy; don't invent benchmark claims.
- Keep the local environment light: only PostgreSQL starts by default.

## Build plan

The project is built in 7 days (A = build, B = verify). See [AGENT.md](AGENT.md#7-seven-day-build-plan).
