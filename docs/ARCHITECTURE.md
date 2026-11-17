# RetailPulse — Architecture

This is the design every change must follow. If code and this document disagree, fix one of them
in the same change. Diagrams use Mermaid (renders on GitHub and in VS Code's Markdown preview
with the "Markdown Preview Mermaid Support" extension).

> All data is synthetic. RetailPulse is an independent portfolio project.

---

## 1. System context

```mermaid
flowchart LR
  user([Store / Inventory Manager, Analyst, Admin])
  web[Web app<br/>React + Vite :5173]
  api[Core API<br/>NestJS modular monolith :3000]
  db[(PostgreSQL<br/>source of truth)]
  fc[Forecasting service<br/>FastAPI :8000]
  pos([POS simulator<br/>scripts/simulation])

  user --> web -->|HTTP /api/v1| api
  pos -->|HTTP /api/v1/sales| api
  api -->|SQL, transactions| db
  api -->|POST /forecast/run| fc
  fc -->|read sales, write forecast.*| db
  api -->|outbox rows, same transaction| db
  db -->|event worker inside the API| api
```

| Component       | Owns                                             | Never does                                |
| --------------- | ------------------------------------------------ | ----------------------------------------- |
| Web             | UI, form validation for UX, hiding buttons a role cannot use | Business rules, authorization decisions (the API re-checks everything) |
| Core API        | All business rules, all writes to operational data | Long-running ML work                    |
| PostgreSQL      | Truth for stock, orders, ledger, recommendations | —                                         |
| Forecasting     | Demand models, backtests, `forecast.*` tables    | Writing inventory, orders or recommendations |
| Event worker (in the API) | Delivering committed outbox events to consumers | Being required for a sale to succeed |

**Why a modular monolith:** one deployable API keeps transactions simple (a sale, its ledger
entry and its outbox event commit together). Modules give the separation of microservices
without network calls. Forecasting is separate only because it is a different runtime (Python).

---

## 2. Core API internal design

### 2.1 Layers (inside each module)

```text
HTTP request
  → Controller   parse + validate input (Zod), call one service method, map to response DTO
  → Service      business rules, transactions, authorization checks on objects
  → Repository   SQL only (pg). No business rules. Returns plain typed rows.
  → PostgreSQL
```

Rules:

1. **Only repositories contain SQL.** Controllers never touch the database.
2. **Services own transactions** via `DatabaseService.transaction(client => …)` and pass the
   `client` down to repositories so every query runs in the same transaction.
3. **Modules talk through exported services**, never another module's repository.
4. **Request schemas are Zod; response shapes are TypeScript interfaces**, both in
   `<module>.schemas.ts`. Repositories alias columns to the response shape (`on_hand AS "onHand"`);
   raw table rows are never returned.

### 2.2 Module map and allowed dependencies

```mermaid
flowchart TB
  subgraph core[core/ — no business logic]
    config & database & http & auth
  end
  health --> database
  auth --> database
  catalog --> database
  locations --> database
  inventory --> catalog & locations & events
  sales --> inventory
  transfers --> inventory & locations
  purchasing --> inventory
  replenishment --> inventory & purchasing & transfers
  events --> database
  alerts --> events & inventory
```

- Arrows point at what a module may call. **No cycles.**
- **`inventory` is the only module that writes `inventory_balances` and `inventory_ledger`.**
  Sales, transfers, purchasing and adjustments all call `InventoryService.applyMovement()`.
- `events` writes the outbox *inside the caller's transaction* (it receives the `client`).
  It knows nothing about its consumers: they register themselves with the `ConsumerRegistry`.

### 2.3 Cross-cutting behaviour (already in place)

| Concern          | Where                                      | Behaviour                                         |
| ---------------- | ------------------------------------------ | ------------------------------------------------- |
| Config           | `core/config/env.ts`                       | Zod-validated at boot; app refuses to start if invalid |
| DB access        | `core/database/database.service.ts`        | One `pg` pool, `query()`, `transaction()`, `ping()` |
| Correlation ID   | `core/http/correlation-id.middleware.ts`   | Accept or create `x-correlation-id`, echo it      |
| Errors           | `core/http/http-exception.filter.ts`       | `{ error: { code, message }, correlationId }`     |
| Versioning       | `bootstrap.ts`                             | Global prefix `/api/v1`                           |

---

## 3. The inventory write path (the most important flow)

Every stock change, whatever the cause, goes through one function:

```mermaid
sequenceDiagram
  participant C as Controller (e.g. sales)
  participant S as SalesService
  participant I as InventoryService.applyMovement
  participant DB as PostgreSQL

  C->>S: createSale(dto, idempotencyKey)
  S->>DB: BEGIN
  S->>DB: idempotency key seen? → return stored response
  S->>DB: INSERT sales_order + lines
  S->>I: applyMovement(client, SALE, product, location, -qty, ref=order)
  I->>DB: INSERT inventory_ledger (deltas, reason, ref)
  Note over DB: BEFORE INSERT trigger: UPDATE inventory_balances (row lock),<br/>CHECKs reject oversell, after-values copied onto the ledger row
  I->>I: CHECK violation → 409 INSUFFICIENT_STOCK
  I->>DB: INSERT outbox_events (same transaction)
  S->>DB: store idempotency response
  S->>DB: COMMIT  (all or nothing)
```

Guarantees and how they are enforced:

| Guarantee                         | Enforced by                                                      |
| --------------------------------- | ---------------------------------------------------------------- |
| No oversell under concurrency     | Trigger's `UPDATE` row-locks the balance; CHECKs run on the locked row (tested with two racing sessions) |
| No negative stock                 | `CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)` |
| Every change is traceable         | Balances change **only** via the ledger trigger; a guard trigger rejects direct `UPDATE`/non-zero `INSERT` on `inventory_balances` — enforced by the database, not just by code |
| Ledger can't be rewritten         | DB trigger rejects `UPDATE`/`DELETE` on `inventory_ledger`       |
| Movements go the right direction  | `ledger_delta_matches_type` CHECK (e.g. `SALE` must be negative, `RESERVATION` only touches reserved) |
| Retries don't double-apply        | `idempotency_keys` table, unique per (key, endpoint)             |
| Event exists iff tx committed     | Outbox row in the same transaction; a rolled-back change creates no event (tested) |

Lock ordering: when a movement touches several balance rows (multi-line sale, transfer), lock
them in a fixed order (`product_id, location_id` ascending) to avoid deadlocks.

---

## 4. Data model

Conventions: `uuid` primary keys (`gen_random_uuid()`), `snake_case`, `created_at`/`updated_at`
as `timestamptz` (UTC), quantities as `integer` **units**, money as `numeric(12,2)`, status and
type columns as Postgres enums or `CHECK` lists.

```mermaid
erDiagram
  categories ||--o{ products : groups
  suppliers ||--o{ supplier_products : offers
  products ||--o{ supplier_products : "sourced via"
  products ||--o{ inventory_balances : "stocked as"
  locations ||--o{ inventory_balances : holds
  inventory_balances ||--o{ inventory_ledger : "explained by"
  locations ||--o{ sales_orders : "sold at"
  sales_orders ||--|{ sales_order_lines : contains
  locations ||--o{ stock_transfers : "from / to"
  stock_transfers ||--|{ stock_transfer_lines : contains
  suppliers ||--o{ purchase_orders : receives
  purchase_orders ||--|{ purchase_order_lines : contains
  users ||--o{ user_store_access : "may access"
  locations ||--o{ user_store_access : ""
  replenishment_recommendations }o--|| products : for
  replenishment_recommendations }o--|| locations : at
```

### Tables by day

| Day | Tables                                                                                     |
| --- | ------------------------------------------------------------------------------------------ |
| 1   | `schema_migrations` (runner)                                                               |
| 2   | `categories`, `suppliers`, `products`, `supplier_products`, `locations`, `inventory_balances`, `inventory_ledger` |
| 3 ✅ | `sales_orders`, `sales_order_lines`, `reservations`, `idempotency_keys`                   |
| 4 ✅ | `users`, `user_store_access`, `sessions`, `stock_transfers`, `stock_transfer_lines` (+ ledger `actor_id` FK) |
| 5 ✅ | `outbox_events`, `processed_events`, `alerts`                                             |
| 6   | `purchase_orders`, `purchase_order_lines`, `replenishment_recommendations`, `forecast.forecast_runs`, `forecast.forecast_points` |

### Key table shapes

**`inventory_balances`** — one row per (product, location). PK `(product_id, location_id)`.
`on_hand int`, `reserved int`, `updated_at`. `available` is computed (`on_hand - reserved`), never stored.

**`inventory_ledger`** — append-only. `id`, `product_id`, `location_id`, `movement_type`,
`on_hand_delta int`, `reserved_delta int`, `on_hand_after int`, `reserved_after int`,
`reason text`, `reference_type`, `reference_id`, `correlation_id`, `actor_id`, `occurred_at`.
Invariant (tested): for every balance, `SUM(on_hand_delta) = on_hand` and `SUM(reserved_delta) = reserved`.

| Movement type         | on_hand_delta | reserved_delta |
| --------------------- | ------------- | -------------- |
| `RECEIPT`             | +q            | 0              |
| `SALE`                | −q            | 0              |
| `RETURN` (sellable)   | +q            | 0              |
| `ADJUSTMENT`          | ±q            | 0              |
| `RESERVATION`         | 0             | +q             |
| `RESERVATION_RELEASE` | 0             | −q             |
| `TRANSFER_OUT`        | −q            | 0              |
| `TRANSFER_IN`         | +q            | 0              |

Damaged returns are recorded with `reason = 'DAMAGED'` and `on_hand_delta = 0` (not sellable).

**Inbound** is derived, never stored: sum of open (approved, not received) PO lines and
dispatched-not-received transfer lines for that product and destination.

### State machines

```text
Transfer:        REQUESTED → APPROVED → DISPATCHED → RECEIVED
                 REQUESTED|APPROVED → CANCELLED
Purchase order:  DRAFT → APPROVED → RECEIVED   (DRAFT|APPROVED → CANCELLED)
Recommendation:  PENDING → APPROVED (creates PO or transfer) | REJECTED | EXPIRED
```

Transitions are checked in the service and guarded in SQL
(`UPDATE … SET status = 'APPROVED' WHERE id = $1 AND status = 'REQUESTED'` → 0 rows ⇒ 409).

---

## 5. API conventions

| Topic          | Rule                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| Base path      | `/api/v1`                                                                    |
| Naming         | Plural nouns: `/products`, `/locations/{id}`, actions as sub-resources: `/transfers/{id}/approve` |
| Validation     | Zod schema per request; failure → `400 VALIDATION_FAILED` with field details |
| Lists          | `?page=1&pageSize=25` (max 100), `?q=` search, `?sort=field:asc`; response `{ data, page, pageSize, total }` |
| Errors         | `{ error: { code, message, details? }, correlationId }`                      |
| Business errors| `409 INSUFFICIENT_STOCK`, `409 INVALID_STATE_TRANSITION`, `404 NOT_FOUND`   |
| Idempotency    | `Idempotency-Key` header (8–100 chars) required on every stock-changing `POST`: `/sales`, `/receipts`, `/returns`, `/adjustments`, `/reservations` (Day 4+: `/transfers`, `/purchase-orders`). A retry returns the stored response with `Idempotent-Replayed: true`; same key + different body → `422 IDEMPOTENCY_KEY_REUSED`. |
| Auth           | Server-side session in an `HttpOnly; SameSite=Strict` cookie (`Secure` in production), 8 h. A **global guard** requires a session and an allowed role on every route; a route without `@Roles()` is ADMIN-only and a test fails if any route declares neither `@Roles` nor `@Public`. Store managers are further limited to their stores in the service layer. Details: *Roles and access* below. |
| Docs           | Endpoint table below; generated OpenAPI at `/api/v1/docs` planned for Day 7  |

### Endpoints so far

| Method & path                         | Query params                                   | Notes |
| ------------------------------------- | ---------------------------------------------- | ----- |
| `GET /health`                         | —                                              | 503 when DB is down |
| `GET /products`                       | `q, categoryId, sort (sku·name·price·available), page, pageSize` | network totals per product |
| `GET /products/:id`                   | —                                              | includes primary supplier terms |
| `GET /products/:id/stock`             | —                                              | one row per location, `asOf` |
| `GET /products/:id/ledger`            | `locationId, movementType, page, pageSize`     | newest first |
| `GET /categories`                     | —                                              | with product counts |
| `GET /locations`                      | `q, type, sort (code·name·type), page, pageSize` | |
| `GET /locations/:id`                  | —                                              | |
| `GET /locations/:id/stock`            | `q, sort (sku·name·onHand·available), page, pageSize` | `asOf` + location |
| `POST /sales`                         | body `{ locationId, lines:[{productId, quantity}] }` | stores only; prices snapshotted; all-or-nothing |
| `GET /sales/:id`                      | —                                              | |
| `POST /receipts`                      | body `{ locationId, reference?, lines }`       | any location |
| `POST /returns`                       | body `{ locationId, productId, quantity, condition: SELLABLE\|DAMAGED, reason? }` | damaged: logged, not restocked |
| `POST /adjustments`                   | body `{ locationId, productId, delta ≠ 0, reason }` | reason required |
| `POST /reservations`                  | body `{ locationId, productId, quantity, reference? }` | lowers available, not on hand |
| `POST /reservations/:id/release`      | — (no key needed; guarded by status)           | `409 INVALID_STATE_TRANSITION` if not ACTIVE |
| `GET /reservations`, `GET /reservations/:id` | `productId, locationId, status, page, pageSize` | |

| `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` | body `{ email, password }` | login is public and rate-limited; `me` needs a session |
| `POST /transfers`                     | body `{ sourceLocationId, destinationLocationId, notes?, lines }` | Idempotency-Key; status `REQUESTED`; nothing moves |
| `GET /transfers`, `GET /transfers/:id` | `status, locationId, productId, page, pageSize` | detail includes lines and who/when per step |
| `POST /transfers/:id/approve`         | —                                              | admin / inventory manager only |
| `POST /transfers/:id/dispatch`        | —                                              | writes `TRANSFER_OUT` at the source |
| `POST /transfers/:id/receive`         | —                                              | writes `TRANSFER_IN` at the destination |
| `POST /transfers/:id/cancel`          | —                                              | only from `REQUESTED` / `APPROVED` |

Stock reads (`/locations/:id/stock`, `/products/:id/stock`) also return `inbound` per row: units on
`APPROVED` / `DISPATCHED` transfers heading to that location (derived, never stored).

| `GET /alerts`                         | `status, kind, locationId, productId, page, pageSize` | store managers: own stores only |
| `POST /alerts/rescan`                 | —                                              | admin / inventory manager |
| `GET /ops/events`                     | —                                              | backlog, retries, dead letters, worker state — admin / inventory manager |
| `GET /ops/events/dead`                | `page, pageSize`                               | admin / inventory manager |
| `POST /ops/events/:id/replay`         | —                                              | `409 EVENT_ALREADY_PENDING` if still queued |

### Roles and access

| Capability                                   | Admin | Inventory mgr | Store mgr (own stores) | Analyst |
| -------------------------------------------- | :---: | :-----------: | :--------------------: | :-----: |
| Read catalog, location directory, network totals | ✅ | ✅ | ✅ | ✅ |
| Read per-location stock, ledger, sales, reservations, transfers | all | all | **own stores** | all |
| Sell, receive, return, adjust, reserve, release | ✅ | ✅ | **own stores** | — |
| Request a transfer                           | ✅    | ✅            | **into own store**     | —       |
| Approve a transfer                           | ✅    | ✅            | —                      | —       |
| Dispatch a transfer                          | ✅    | ✅            | **from own store**     | —       |
| Receive a transfer                           | ✅    | ✅            | **at own store**       | —       |
| Cancel a transfer                            | ✅    | ✅            | **touching own store** | —       |

- Role is checked by the global guard (`@Roles(...)`, 403 `FORBIDDEN`); store scope is checked in
  services with `core/auth/access.ts` (403 for a store manager's other stores, filtered rows for lists).
- Network aggregates (product `totalOnHand`/`totalAvailable`) are visible to every role so store
  managers can see where stock exists before requesting a transfer; per-location rows, the
  ledger, sales, reservations and transfers are scoped. Other stores' location totals are `null`.
- Services receive a `RequestContext { correlationId, user }` (the `@Ctx()` decorator) and stamp
  `actor_id` on every ledger row they write.
- Demo accounts (`npm run db:seed`, one shared password from `DEMO_PASSWORD`): `admin@`,
  `inventory@`, `store1@` (STR-01), `store2@` (STR-02), `analyst@` — all `@retailpulse.test`.

Business errors: `409 INSUFFICIENT_STOCK` (with `details`), `409 PRODUCT_INACTIVE`,
`422 INVALID_LOCATION_TYPE`, `422 IDEMPOTENCY_KEY_REUSED`, `404 NOT_FOUND`.

---

## 6. Events (no message broker)

```mermaid
flowchart LR
  tx[Stock movement<br/>applyMovement] -->|same COMMIT| outbox[(outbox_events)]
  outbox --> w[Event worker in the API<br/>claims one event: FOR UPDATE SKIP LOCKED]
  w -->|first time for this consumer?| processed[(processed_events)]
  w --> cons[Low-stock consumer]
  cons --> alerts[(alerts)]
  w -->|consumer throws: roll back, retry with backoff| outbox
  w -->|3rd failure| dead[DEAD rows = dead letters]
```

There is deliberately **no Kafka**: nothing in RetailPulse needs a broker, and the valuable part —
the transactional outbox with idempotent consumers — works on PostgreSQL alone. A broker can be
added later by writing one more consumer that forwards events (see decision #26).

**How one event is processed** (one transaction per event, `EventDispatcher`):

1. Claim the oldest due event (`FOR UPDATE SKIP LOCKED`), so several workers never take the same one.
2. For each consumer of that event type: insert `(consumer, eventId)` into `processed_events`;
   if it already exists the consumer already handled this event → **skip** (idempotent).
3. Run the consumer; its writes happen in the same transaction (a `SAVEPOINT` wraps them).
4. Success: mark the event `PROCESSED` and commit. Failure: roll back to the savepoint (the
   consumer's partial writes disappear), record `attempts + 1`, `last_error` and a backoff
   (2 s, 4 s); after **3** attempts the event becomes `DEAD`.
5. Operators see the backlog on `GET /ops/events`, list `DEAD` events on `/ops/events/dead`, and
   re-deliver one with `POST /ops/events/:id/replay` (consumers that already handled it skip it).

Guarantees: at-least-once delivery, effectively-once effects; a sale never depends on the worker
(with the worker stopped, events simply queue); a "due" brand-new event never depends on the
wall clock (clocks can step backwards — retries are the only clock-based wait).
Not guaranteed: strict ordering (a failing event is retried later while newer ones continue), so
consumers judge **current state**, not the event's numbers.

Envelope:

```json
{
  "eventId": "uuid",
  "eventType": "inventory.movement.recorded",
  "schemaVersion": 1,
  "occurredAt": "2026-01-01T10:00:00Z",
  "correlationId": "uuid",
  "aggregateType": "inventory_balance",
  "aggregateId": "<product_id>:<location_id>",
  "payload": {
    "ledgerId": "123", "productId": "…", "locationId": "…", "movementType": "SALE",
    "onHandDelta": -2, "reservedDelta": 0, "onHandAfter": 6, "reservedAfter": 0,
    "referenceType": "SALES_ORDER", "referenceId": "…", "actorId": "…"
  }
}
```

Payloads carry business data only — no free-text ledger reason, no personal data.
The columns of an event are immutable after insert (a trigger rejects edits); only its
processing state (status, attempts, error) changes.

### Low-stock alerts (the first consumer)

After every movement the `low-stock-alerts` consumer judges the **current** stock of that
product at that location (`available = on hand − reserved`) and makes the alerts match:

| State                       | Alert                              | Severity |
| --------------------------- | ---------------------------------- | -------- |
| `available ≤ 0`             | `OUT_OF_STOCK`                     | HIGH     |
| `available < one pack`      | `LOW_STOCK`                        | MEDIUM   |
| otherwise                   | none — any open alert is resolved  | —        |

At most one **OPEN** alert exists per product, location and kind (a partial unique index), so
duplicate or concurrent processing cannot create two. Each alert stores its inputs
(`available`, `onHand`, `reserved`, `packSize`, the event) so the UI can answer "why?".
`POST /alerts/rescan` re-checks every low position (use it after loading data that did not go
through events, such as the seed). Day 6 replaces "one pack" with a forecast-based reorder point.

---

## 7. Forecasting & replenishment (Day 6)

```mermaid
flowchart LR
  ledger[(SALE ledger rows)] --> agg[Daily demand<br/>per SKU × location]
  agg --> base[Baselines:<br/>moving avg 28d, seasonal naive 7d]
  agg --> ml[scikit-learn model<br/>lags + day-of-week]
  base & ml --> bt[Rolling time-based backtest<br/>MAE · RMSE · WAPE]
  bt --> pick[Serve ML only if it beats baseline WAPE]
  pick --> fp[(forecast.forecast_points)]
  fp --> rp[API: reorder point, safety stock,<br/>days of cover]
  rp --> rec[(replenishment_recommendations<br/>PENDING + all inputs)]
  rec -->|manager approves| act[PO or transfer created]
```

- The forecasting service reads sales history and writes **only** `forecast.*` tables.
- The API computes recommendations and stores every input used, so the UI can show "why".
- Nothing is ordered or moved without an approval.

---

## 8. Folder structure

Legend: ✅ exists now · `(Dn)` added on day n. Don't create folders before they're needed.

```text
RetailPulse/
├── AGENT.md                         rules + 7-day plan for AI agents
├── README.md                        what it is + quick start
├── docs/
│   └── ARCHITECTURE.md ✅           this file
├── docker-compose.yml ✅            postgres (observability profile later)
├── .env.example ✅
├── package.json ✅                  npm workspaces + root scripts
├── eslint.config.mjs ✅  .prettierrc.json ✅
├── .github/workflows/ci.yml ✅
│
├── services/
│   ├── api/                         NestJS core API
│   │   ├── migrations/ ✅           0001_init.sql, 0002_….sql (never edit applied files)
│   │   ├── scripts/
│   │   │   ├── migrate.mjs ✅       migration runner
│   │   │   └── seed.mjs ✅          deterministic synthetic demo data (--reset)
│   │   ├── src/
│   │   │   ├── main.ts ✅           entry point: load env → create app → listen
│   │   │   ├── bootstrap.ts ✅      shared wiring (prefix, middleware, filters)
│   │   │   ├── app.module.ts ✅     imports core + feature modules
│   │   │   ├── core/                cross-cutting, no business logic
│   │   │   │   ├── config/ ✅       env.ts
│   │   │   │   ├── database/ ✅     database.module.ts, database.service.ts, sql.ts
│   │   │   │   ├── http/ ✅         correlation-id, exception filter, zod pipe, query.ts (page/sort)
│   │   │   │   └── auth/ (D4)       session guard, roles decorator, store-access guard
│   │   │   └── modules/             one folder per business domain
│   │   │       ├── health/ ✅
│   │   │       ├── catalog/ ✅      products, categories, supplier terms
│   │   │       ├── locations/ ✅
│   │   │       ├── inventory/ ✅    stock + ledger reads; (D3) applyMovement()
│   │   │       ├── sales/ ✅
│   │   │       ├── reservations/ ✅
│   │   │       ├── transfers/ ✅    request → approve → dispatch → receive / cancel
│   │   │       ├── auth/ ✅         login, logout, me, login throttle
│   │   │       ├── events/ ✅       outbox writer, worker (dispatcher), retries, dead letters, ops endpoints
│   │   │       ├── alerts/ ✅
│   │   │       ├── purchasing/ (D6)
│   │   │       └── replenishment/ (D6)
│   │   └── test/
│   │       ├── app.spec.ts ✅       HTTP tests with a mocked DB
│   │       └── integration/ ✅      *.int-spec.ts, each in its own throw-away database
│   │
│   └── forecasting/                 FastAPI + ML
│       ├── app/
│       │   ├── main.py ✅           FastAPI app + routes
│       │   ├── db.py (D6)           psycopg connection (read sales, write forecast.*)
│       │   ├── models/ (D6)         baselines.py, ml.py
│       │   ├── evaluation/ (D6)     backtest.py, metrics.py
│       │   └── synthetic/ (D6)      sales history generator
│       ├── tests/ ✅
│       ├── pyproject.toml ✅        ruff + pytest config
│       └── requirements*.txt ✅     pinned
│
├── apps/
│   └── web/                         React + Vite + Tailwind
│       └── src/
│           ├── main.tsx ✅          entry
│           ├── App.tsx ✅           layout shell (header, nav, page outlet)
│           ├── api/ ✅              client.ts (fetch + error handling), types per domain
│           ├── components/ ✅       Badge, Status (loading/error/empty/asOf), Pagination, table.ts
│           ├── lib/ ✅              router.ts (hash routes), useAsync.ts, format.ts
│           └── pages/ ✅            Products, ProductDetail, Stock, Health
│
└── scripts/simulation/pos-sim.mjs ✅  POS traffic simulator (npm run sim:pos)
```

### Module file convention (API)

```text
modules/inventory/
├── inventory.module.ts       Nest module: providers + exports
├── inventory.controller.ts   HTTP only
├── inventory.service.ts      rules + transactions
├── inventory.repository.ts   SQL only
├── inventory.schemas.ts      Zod request schemas + response interfaces
└── inventory.service.spec.ts unit tests next to the code
```

### Naming

| Thing              | Convention                       | Example                         |
| ------------------ | -------------------------------- | ------------------------------- |
| TS files           | `kebab-case.<role>.ts`           | `stock-transfer.service.ts`     |
| Classes            | `PascalCase`                     | `InventoryService`              |
| DB tables/columns  | `snake_case`, plural tables      | `inventory_balances.on_hand`    |
| JSON fields        | `camelCase`                      | `onHand`, `locationId`          |
| Migrations         | `NNNN_verb_subject.sql`          | `0002_create_catalog.sql`       |
| Error codes        | `UPPER_SNAKE`                    | `INSUFFICIENT_STOCK`            |
| Env vars           | `UPPER_SNAKE`                    | `DATABASE_URL`                  |

---

## 9. Testing strategy

| Level              | Tool                       | What                                                  | When it runs |
| ------------------ | -------------------------- | ----------------------------------------------------- | ------------ |
| Unit               | Jest / Pytest              | Pure rules: reorder point, state transitions, rounding | every check |
| HTTP               | Jest + Supertest (mock DB) | Routing, validation, error shape                       | every check |
| Integration        | Jest + real Postgres       | Constraints, concurrency, rollback, idempotency        | CI + locally with DB up |
| E2E (D7)           | Playwright                 | One happy path through the UI                          | CI |

Inventory tests listed in AGENT.md §9 are mandatory before Day 3 is done.

---

## 10. Decision log

| # | Decision | Why | Trade-off |
| - | -------- | --- | --------- |
| 1 | PostgreSQL as the only operational DB | Transactions, row locks, constraints, `SKIP LOCKED` | Single node in MVP |
| 2 | Modular monolith API | Atomic transactions without distributed coordination | Modules must stay disciplined (rules in §2) |
| 3 | Plain SQL + `pg`, no ORM | Locking/ledger SQL stays explicit and reviewable | More typing of row types |
| 4 | Own tiny migration runner | No dependency; checksums stop edited migrations | Fewer features than big tools |
| 5 | Integer unit quantities | No fractional stock in this domain | Weight-based items out of scope |
| 6 | Ledger deltas + after-values | Balance is provable from the ledger | Slightly larger rows |
| 7 | Transactional outbox | Event iff commit; the worker being down never blocks a sale | Delivered by a worker (see #26) |
| 8 | Forecasting writes only `forecast.*` | ML can't mutate operational data | API must read forecast tables |
| 9 | npm workspaces, one lockfile | Simple, built in | No task caching |
| 10 | NestJS 12 with `module: nodenext` | Nest 12 is ESM-only; matches official template | Jest needs `--experimental-vm-modules` |
| 11 | Balances maintained by a ledger trigger (Day 2) | The DB itself guarantees balance = Σ ledger, even for scripts/SQL that bypass the API | Logic lives partly in SQL; covered by integration tests |
| 12 | Hash router + `useAsync` hook in the web app | Five screens don't justify a router/data library | Revisit if the UI grows a lot |
| 13 | Integration tests use separate databases (refined by #32: one per test file) | Tests never touch dev data; reseeded per test file | Needs Postgres running (`npm run db:up`) |
| 14 | Idempotency key row lives in the same transaction as the work (Day 3) | A failed request leaves no key, so it can be retried; concurrent duplicates wait, then replay | Keys accumulate; a cleanup job is planned (Day 7) |
| 15 | Multi-line writes lock balance rows in `product_id` order | Prevents deadlocks between concurrent multi-line sales (tested) | Callers must use `sortByProduct()` |
| 16 | Damaged returns write a ledger row with `on_hand_delta = 0` and the quantity in the reason text | Keeps the ledger complete without making damaged goods sellable | Damaged quantity is not queryable as a number yet |
| 17 | ~~Write endpoints unauthenticated until Day 4~~ | Superseded by #19 — every route now needs a session and a role | — |
| 18 | scrypt (built into Node) for password hashing | Memory-hard, no native dependency to compile; params stored per hash so they can be raised | Not argon2; revisit if a prebuilt argon2 is wanted |
| 19 | Server-side sessions; only a SHA-256 of the token is stored; `SameSite=Strict` cookie | Instant logout/disable, a DB leak yields no usable sessions, CSRF mitigated without tokens | One DB lookup per request |
| 20 | Deny-by-default global guard + route-coverage test | A forgotten decorator can never expose a route | Every new route must declare `@Roles` or `@Public` |
| 21 | Store scope enforced in services via `core/auth/access.ts` | Same helper for reads (filter) and writes (403); testable with real data | Services take a `RequestContext` |
| 22 | In-memory login throttle (5 failures / 15 min per email + IP) | Simple and enough for one instance | Resets on restart, not shared across instances — move to PostgreSQL/Redis before scaling out |
| 23 | Approval does not reserve stock; dispatch fails with `INSUFFICIENT_STOCK` if the source ran short | Keeps transfers simple; stock stays sellable until it physically leaves | A sale can consume stock between approval and dispatch |
| 24 | Transfers send and receive the full requested quantity | No partial-delivery workflow in the MVP; shortages are fixed with an adjustment | No per-line discrepancy tracking |
| 25 | Transfer status order is enforced by a DB trigger + CHECK, not only by the service | No code path or manual SQL can skip a step | Logic partly in SQL; covered by tests |
| 26 | **No Kafka**: PostgreSQL outbox + a worker inside the API (user decision, Day 5) | No extra container or ~1 GB of RAM; nothing here needs a broker; the outbox/idempotent-consumer pattern is the same | Only in-process consumers; to feed another system later, add a consumer that publishes to a broker |
| 27 | One transaction per event: claim → consumers → mark processed (`SAVEPOINT` around consumers) | A consumer's writes and "handled" commit or roll back together; a failure leaves no partial effect | Events are processed one at a time per worker |
| 28 | `processed_events (consumer, event_id)` makes consumers idempotent | Replays and duplicates are harmless (tested, incl. 3 concurrent workers) | Table grows; cleanup with the outbox (Day 7) |
| 29 | Dead letters are `DEAD` rows in `outbox_events`, not a second table | One place to monitor and replay; no copying | Listing dead events filters the same table |
| 30 | Alerts judge *current* stock, not the event's numbers | Correct even if events arrive late or out of order; re-processing is harmless | One extra read per event |
| 31 | A never-attempted event is due immediately; only retries wait on the clock | The test machine's clock stepped backwards (up to ~480 ms) and freshly created events looked "in the future" — found by stress-testing | Retry backoff can be a little longer after a backwards clock step |
| 32 | Integration tests use one throw-away database per test file | Two test runs at once (yours, CI, an editor) used to wipe each other's data; found while chasing flaky tests | ~3 s extra setup per file |
