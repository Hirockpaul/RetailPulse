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
| Event streaming     | Apache Kafka (optional compose profile)        | Day 5     |
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
                                   └── outbox ──▶ Kafka ──▶ consumers (alerts)   [Day 5]
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

```bash
npm run dev:api
```

In a second terminal:

```bash
npm run dev:web
```

Open http://localhost:5173 — the page shows live API and database health.

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
| `GET http://localhost:8000/health`    | Forecasting service status            |

## Quality checks

```bash
npm run check
```

Runs format check, lint, typecheck, tests and build for the TypeScript apps. Python:

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
