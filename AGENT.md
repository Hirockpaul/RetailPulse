# RetailPulse — Agent Instructions

Rules for any AI coding agent (Claude Code, Cursor, Codex, Copilot…) working in this repo.
RetailPulse is an **independent simulation** using synthetic data only. Never imply it is
connected to, used by, or based on any real retailer.

---

## 1. Mission

Build a **simple, strong** inventory platform for a fictional multi-store retailer:

- Accurate stock per product per location (stores + distribution centres).
- Sales, receipts, transfers, reservations, adjustments, returns — all traceable.
- Demand forecasts from historical sales, evaluated honestly against a baseline.
- Explainable replenishment suggestions that a manager approves.

Not a CRUD demo. Not over-engineered either.

## 2. Keep it simple (anti-over-engineering rules)

- **One API app** (NestJS modular monolith) + **one Python service** (forecasting). No other services.
- **Plain SQL** migrations and queries with `pg`. No ORM.
- **No Redis, Superset, Kubernetes, Java** unless the user approves a concrete need.
- **No Kafka** (decision with the user, Day 5): events use the PostgreSQL outbox and an in-API
  worker. Prometheus and Grafana, when added, are optional compose profiles, never by default.
- No new framework/library without a concrete requirement. Prefer the standard library.
- One package manager: **npm** (workspaces, one root `package-lock.json`). Python: `pip` + `.venv`.
- Write the smallest code that satisfies the day's acceptance checklist, then stop.

## 3. Stack (fixed unless the user approves a change)

| Area        | Choice                                                      |
| ----------- | ----------------------------------------------------------- |
| Web         | React 19, TypeScript, Vite, Tailwind CSS v4                 |
| API         | NestJS 11, TypeScript, `pg`, Zod (env + request validation) |
| DB          | PostgreSQL 17                                               |
| Forecasting | Python 3.12, FastAPI, Pandas, NumPy, scikit-learn, Pydantic |
| Events      | PostgreSQL transactional outbox + in-API worker (no Kafka)  |
| Tests       | Jest + Supertest (API), Pytest (Python)                     |
| Lint/format | ESLint (flat config), Prettier, Ruff                        |

## 4. How to work

**Before changing code**

1. Read `README.md`, this file, **`docs/ARCHITECTURE.md`**, and the code you are about to touch.
2. Check `git status`. Never overwrite or discard uncommitted user changes.
3. Know which day/step of the plan you're on and its acceptance checklist.

**Where code goes** (full tree in `docs/ARCHITECTURE.md` §8):

- API business code → `services/api/src/modules/<domain>/` with the files
  `<domain>.module.ts`, `.controller.ts` (HTTP only), `.service.ts` (rules + transactions),
  `.repository.ts` (SQL only), `.schemas.ts` (Zod), `*.spec.ts` (tests next to code).
- Cross-cutting API code (config, DB, HTTP, auth) → `services/api/src/core/`. No business logic there.
- Only the `inventory` module writes `inventory_balances` / `inventory_ledger`.
- Modules call other modules' **services**, never their repositories. No dependency cycles.
- Web → `apps/web/src/{api,components,pages}`. Pages never call `fetch` directly; use `src/api/`.
- Don't create folders for future days ahead of time.
- If a change needs a design deviation, update `docs/ARCHITECTURE.md` (decision log) in the same change.

**While changing code**

- One vertical slice at a time. No unrelated refactors.
- Every behaviour change comes with a test.
- Schema change ⇒ **new** migration file `services/api/migrations/NNNN_name.sql`.
  Never edit an applied migration — the runner rejects changed checksums.

**Before saying "done"** run and report real results:

```bash
npm run check
```

```bash
cd services/forecasting && .venv/bin/ruff check . && .venv/bin/pytest
```

If a check can't run (e.g. Docker down), say so. Never claim it passed. Never weaken a test to get green.

## 5. Non-negotiable rules

### Database & inventory

- PostgreSQL is the source of truth. Constraints (FK, UNIQUE, CHECK) enforce invariants.
- Every stock change = one transaction: lock balance row (`SELECT … FOR UPDATE`) → insert
  ledger entry → update balance → insert outbox event. All or nothing.
- No negative on-hand / available stock (CHECK constraints + service check).
- **No generic "set quantity" endpoint.** Corrections are `ADJUSTMENT` movements with a reason.
- Money: `NUMERIC(12,2)`. Time: `timestamptz`, stored UTC.
- Retry-able writes (sales, transfers) require an `Idempotency-Key` header.

### Stock concepts

- `on_hand` — physically at the location.
- `reserved` — committed to unfulfilled orders.
- `available = on_hand - reserved`.
- `inbound` — on approved, not-yet-received POs/transfers.
- `inventory_position = available + inbound` (no backorders in MVP).

Movement types: `SALE`, `RECEIPT`, `TRANSFER_OUT`, `TRANSFER_IN`, `RETURN`, `ADJUSTMENT`,
`RESERVATION`, `RESERVATION_RELEASE`.
Transfer lifecycle: `REQUESTED → APPROVED → DISPATCHED → RECEIVED` (or `CANCELLED` before dispatch).

### API

- Prefix `/api/v1`. Validate all input with Zod at the boundary.
- Error shape: `{ "error": { "code", "message" }, "correlationId" }`.
- List endpoints: `?page&pageSize` (max 100), filters, sort.
- Authorization on the server, including per-store access for Store Managers.

### Events (Day 5+)

- Transactional outbox; at-least-once delivery; consumers idempotent via `processed_events`.
- Produce events only by calling `EventsService.record(client, …)` inside the transaction of the
  change (today `InventoryService.applyMovement()` does it). Never publish after commit.
- Add a consumer by implementing `EventConsumer` and registering it with the `ConsumerRegistry`.
  Consumers must judge current state (events can be late or out of order) and keep all their
  writes on the `client` they are given, so a failure rolls them back.
- Envelope: `eventId, eventType, occurredAt, schemaVersion, correlationId, aggregateType, aggregateId, payload`.
- Retries with backoff, 3 attempts, then `DEAD` (dead letter). No secrets/PII in events.
- Never rely on the wall clock for "is a new event ready" (clocks step backwards).

### Forecasting & replenishment

- Baselines first: moving average, seasonal naive (7-day).
- Time-based train/test split only. No future data in features (no leakage).
- Report MAE, RMSE, WAPE per SKU/location and overall, vs. baseline.
- Persist model name/version, training window, metrics, generated-at time.
- `reorderPoint = avgDailyDemand × leadTimeDays + safetyStock`,
  `safetyStock = z × σ(daily demand) × √leadTimeDays`. Document assumptions.
- Suggested qty: raise position to cover lead time + review period, then round **up** to pack
  size and at least MOQ. Every recommendation stores its inputs for explanation.
- ML never mutates inventory or creates orders. A manager approves.

### Security

- Secrets only in `.env` (git-ignored). Commit `.env.example` with placeholders.
- Passwords hashed with scrypt (Node built-in; argon2/bcrypt also acceptable). Sessions are
  server-side; the cookie is HttpOnly + SameSite=Strict (+ Secure in production).
- Roles: `ADMIN`, `INVENTORY_MANAGER`, `STORE_MANAGER`, `ANALYST`.
- Don't log credentials, tokens or full request bodies. Rate-limit login.

### Honesty

- Label synthetic data in the UI. No fake "live" indicators.
- No "real-time", "AI-powered", "production-ready", "enterprise scale" claims without evidence.
- Performance goals (e.g. p95 < 300 ms on local reads) are targets to **measure**, not claims.

## 6. Domain model (grows day by day)

`users, user_store_access` · `categories, suppliers, products, supplier_products` ·
`locations (STORE | DISTRIBUTION_CENTER)` · `inventory_balances, inventory_ledger` ·
`sales_orders(+lines), reservations` · `purchase_orders(+lines), stock_transfers(+lines)` ·
`idempotency_keys` · `outbox_events, processed_events, alerts` ·
`demand_daily, forecast_runs, forecast_points` · `replenishment_recommendations`

---

## 7. Seven-day build plan

Each day has **A — Build** and **B — Verify/harden**. A day is done only when its checklist passes.

### Day 1 — Foundation ✅

- **A — Build:** npm workspaces; NestJS API with `/api/v1/health` (API + DB status);
  env validation (Zod); correlation-ID middleware + consistent error filter; Postgres in
  Docker Compose; SQL migration runner; React + Tailwind page showing health; FastAPI `/health`.
- **B — Verify:** ESLint, Prettier, Ruff; Jest/Supertest + Pytest tests; GitHub Actions CI
  (lint, typecheck, test, build, migrations against a Postgres service).
- **Checklist:** fresh clone → README steps → health page green · health returns 503 when DB
  is down · no secrets committed · `npm run check` passes.

### Day 2 — Catalog, locations, ledger ✅

- **A — Build:** migrations for `categories, suppliers, products, supplier_products,
  locations, inventory_balances, inventory_ledger` (+ CHECK `on_hand >= 0`, `reserved >= 0`,
  `reserved <= on_hand`). Synthetic seed script (5 stores, 2 DCs, ~200 SKUs, 3 suppliers).
  Read endpoints: products (search, paginate), locations, stock by location/product, ledger by product.
- **B — Verify:** tests for constraints (duplicate SKU, negative stock rejected), pagination
  limits, 404/400 error shape. Web: Products and Stock tables (loading/empty/error states).
- **Checklist:** balances equal the sum of their ledger entries (test query) · seed is labelled synthetic.
- **Done notes:** balances are maintained by a ledger trigger and can't be edited directly
  (see ARCHITECTURE decision #11). Integration tests: `npm run test:int` (needs `npm run db:up`).

### Day 3 — Stock movements (the core) ✅

- **A — Build:** `InventoryService.applyMovement()` — the **only** code path that changes
  stock (row lock → ledger → balance). Endpoints: POS sale, receipt, return
  (sellable vs damaged), adjustment (reason required), reservation + release.
  `Idempotency-Key` table for sales.
- **B — Verify:** integration tests on real Postgres: sale reduces available · reservation
  reduces available not on-hand · release restores · receipt increases on-hand ·
  **20 concurrent sales on 10 units → exactly 10 succeed** · duplicate key → same response,
  one ledger row · failure mid-transaction → nothing written.
- **Checklist:** every stock change has a ledger row · no oversell under concurrency.
- **Done notes:** `POST /sales|receipts|returns|adjustments|reservations` (+ release), all with
  `Idempotency-Key`; `npm run sim:pos` simulates POS traffic; product page has a movement form.
  Use `InventoryService.applyMovement()`
  for any new stock change and lock multi-line writes with `sortByProduct()`.

### Day 4 — Transfers, users & roles ✅

- **A — Build:** transfer lifecycle (request → approve → dispatch = `TRANSFER_OUT` →
  receive = `TRANSFER_IN`; cancel before dispatch); inbound quantity derived from open
  transfers/POs. Users + roles + store access, scrypt passwords, session cookie login, seeded
  demo accounts (one per role).
- **B — Verify:** status-transition tests (illegal transitions rejected), role/store guard tests
  (store manager can't touch another store), login rate limit. Web: login + transfers page.
- **Checklist:** transfer touches both locations only via ledger · authZ enforced server-side.

### Day 5 — Events (outbox, no Kafka) ✅

- **A — Build:** `outbox_events` written inside the movement transaction; an in-API worker
  (`FOR UPDATE SKIP LOCKED`, one transaction per event) runs registered consumers; a consumer
  raises low-stock `alerts`; `processed_events` for idempotency; retry ×3 with backoff, then
  `DEAD` (dead letters). **Decision: no Kafka** — it adds a container and ~1 GB of RAM and
  nothing here needs a broker.
- **B — Verify:** committed tx ⇒ event · rolled-back tx ⇒ no event · same event twice ⇒ one
  alert · poison event ⇒ dead letter, replay recovers it · three workers at once ⇒ each event
  exactly once. Backlog, retries and dead letters visible on `/api/v1/ops/events`.
- **Checklist:** core sale works with the worker **stopped** (events just queue) ·
  worker stops cleanly on shutdown.
- **Done notes:** web has an Alerts page and an events card on Health. Setting
  `EVENT_WORKER_ENABLED=false` runs the API without the worker; tests use that and call
  `dispatcher.runOnce()` themselves. Old events are not purged yet (Day 7).

### Day 6 — Forecasting & replenishment

- **A — Build (Python):** synthetic 12-month daily sales generator (trend + weekly
  seasonality + noise, seeded RNG); `demand_daily` aggregation; models: moving average (28d),
  seasonal naive (7d), and one scikit-learn model (e.g. `GradientBoostingRegressor` on lag/
  day-of-week features); rolling time-based backtest with MAE/RMSE/WAPE; persist
  `forecast_runs` + `forecast_points`; `POST /forecast/run`, `GET /forecast/{sku}/{location}`.
  Low-history fallback: category average, flagged.
- **B — Build (API):** reorder point, safety stock, stockout-risk (days of cover),
  recommendation = transfer from DC if DC has stock, else PO; rounds to pack size/MOQ;
  stores inputs + formula; approve/reject endpoints — approve creates the PO/transfer.
- **Checklist:** ML model only used if it beats baseline on WAPE (otherwise baseline is
  served, and that's reported) · nothing is ordered without approval.

### Day 7 — Dashboard, observability, demo

- **A — Build:** web pages: Overview (stock-out risk, excess, pending recommendations,
  freshness timestamps), Recommendation detail ("why" panel with every input), Forecast
  chart with accuracy. `/metrics` (prom-client) on API; optional `observability` compose
  profile (Prometheus + Grafana with one dashboard: latency, errors, outbox backlog).
- **B — Verify/ship:** Dockerfiles (multi-stage), `docker compose --profile full up` demo,
  `npm run demo` (seed + simulated POS traffic), one Playwright happy-path test, README
  walkthrough + measured numbers + known limitations.
- **Checklist:** fresh clone → demo in < 10 commands · all claims backed by measurements.

**After Day 7 (only if wanted):** Superset for BI, Redis cache, hosted demo (check costs first).

---

## 8. Report format after each task

1. **Implemented** — what actually changed.
2. **Decisions** — notable choices/trade-offs.
3. **Files** — paths touched.
4. **Validation** — exact commands + pass/fail.
5. **Limitations** — gaps, unrun checks.
6. **Next step** — smallest next task in the plan.
