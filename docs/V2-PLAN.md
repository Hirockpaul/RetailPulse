# RetailPulse V2 — Phase 0 audit and implementation plan

Status: decisions D1, D2, D4 confirmed; built one step at a time (§0). **Phases 1 and 2 and
Phase 3, Phase 4 and Phase 5 (5a–5e) are built** (see §9); next is step 6, final verification and
release notes.
Written 2026-11-17 against commit `887047f` (Day 7; CI green: node, e2e, docker, forecasting).
All data in RetailPulse is synthetic.

---

## 0. Working agreement: one small step at a time

V2 is **not** built all at once, and not even a whole phase at once. Each step below
(1a, 1b, 1c, …) is built alone, then:

1. all checks run (`npm run check`, `npm run test:int`, `npm run forecast:test`, `npm run test:e2e`);
2. a short report (what changed, how data gets in, measured results, limitations);
3. **the user approves** before the next step starts; a step is committed only when asked.

If a step turns out bigger than expected, it is split again rather than rushed.

| Step | Content | Depends on |
|---|---|---|
| 1a | Data foundation: promotions calendar, labelled anomalies, bias/coverage metrics, re-encoded features, re-measured accuracy | — |
| 1b | Probabilistic forecast (conformal intervals, measured coverage) | 1a |
| 1c | SHAP explanations + "Why this forecast?" panel | 1a |
| 1d | Model comparison (Random Forest only if it earns its place) | 1a |
| 1e | Anomaly detection + review workflow + Anomalies page | 1a |
| 2a | ABC/XYZ classification + page | 1a |
| 2b | Safety stock v2 (service levels, forecast error, lead-time variability) | 1b, 2c |
| 2c | Supplier performance statistics (synthetic PO history) | — |
| 2d | Replenishment v2 (redistribution, manual review, stockout date) | 2b |
| 3a | Model registry + manager activation + rollback | 1a |
| 3b | MLflow (optional profile) | 3a |
| 3c | Drift + performance monitoring + Model Monitoring page | 3a |
| 4a | Control Tower (Overview extended) | 1e, 2a |
| 4b | What-if scenarios | 2d |
| 4c | Reports (CSV + print) | 4a |
| 4d | Grafana business dashboards (read-only SQL views) | 2c |
| 5a–5e | OpenAPI · OpenTelemetry · security review · performance · backup/restore | — |
| 6 | Final verification and release notes | all |

## 1. Audit — what exists today (verified in the code)

### 1.1 Architecture (unchanged by V2)

```text
React (Vite) ──/api/v1──▶ NestJS modular monolith ──SQL──▶ PostgreSQL (source of truth)
                              │   ▲                               ▲
                              │   └── in-API event worker (outbox) ┘
                              └──HTTP──▶ FastAPI forecasting ──reads history, writes forecast.* only
```

- One API process with 16 modules; `InventoryService.applyMovement()` is the only stock write path;
  balances are maintained by a ledger trigger and cannot be edited directly (DB-enforced).
- Python writes only the `forecast` schema (source-scan test + DB test).
- Deny-by-default global auth guard; store scope enforced in services (`core/auth/access.ts`).
- Optional compose profiles: `full`, `observability` (Prometheus + Grafana).

### 1.2 Feature check against the V2 brief

| V2 item | Today | Verdict |
|---|---|---|
| Stock, ledger, movements, transfers, reservations, roles, outbox, alerts | Built, tested (202 integration tests) | Keep untouched |
| Model comparison (baselines vs ML, time-based windows) | `evaluation/backtest.py`: 28-day validation + 28-day untouched test, rolling origins, MAE/RMSE/WAPE persisted in `forecast.model_metrics`; ML served only if it beats the best baseline on both | **Exists**; missing: bias metric, per-horizon metrics, coverage |
| Model versions | `forecast.model_versions` (name, version, kind, params) | **Partial**: no activation/approval/rollback, no stored artifact |
| Probabilistic forecast | `points.lower/upper` = yhat ± 1.2816 × σ (σ = per-series backtest RMSE), clipped at 0 | **Partial**: symmetric normal band on count data; **coverage never measured** |
| Explainability (ML) | none | Missing |
| Anomaly detection | none (alerts are rule-based stock levels only) | Missing |
| ABC/XYZ | none | Missing |
| Safety stock | `z × σ × √L`, z fixed 1.645, σ = `std_daily_90` (historical demand std) | **Partial**: fixed service level, no lead-time variability, σ is demand std not forecast error |
| Supplier lead time | one fixed `lead_time_days` per supplier-product; POs store `expected_date`, `received_at` | **No history**: demo POs are received minutes after creation |
| Replenishment | transfer-or-PO, pack/MOQ rounding, DC allocation, approval creates document | Exists; extend |
| Dashboard | Overview page (`GET /overview`): out of stock, at risk 7 d, excess, pending recs, freshness | **Exists**; extend into the Control Tower (do not build a second dashboard) |
| Metrics | `/metrics` + Grafana dashboard | Exists |
| OpenAPI | none (decision #47) | Missing |
| Tracing | correlation IDs only | Missing |
| Backup/restore | none | Missing |
| Frontend component tests | none (no test runner in `apps/web`) | Missing |
| E2E | 1 Playwright happy path | Exists; extend |

### 1.3 Current ML, exactly

- **Models:** `moving_average_28`, `seasonal_naive_7`, `hgb_direct` (one global
  `HistGradientBoostingRegressor`, Poisson loss, direct multi-horizon, 13 features: means 7/28/56 d,
  std 28 d, same-weekday values, ratio 7/28, weekday, horizon, season sin/cos, category, store;
  weekday/category/store are **native categorical** features).
- **Metric used for selection and in the docs:** WAPE pooled over series with ≥ 56 days of history,
  1–7 days ahead. Measured (ARCHITECTURE §7.3): test WAPE **52.2 %** (hgb) vs **54.3 %**
  (moving average), noise floor **50.9 %**. These are the only accuracy numbers V2 may quote until
  re-measured.
- **Low history:** category × store average, flagged `is_fallback`.

### 1.4 Findings that change the V2 design

1. **SHAP spike (run today, throw-away venv, shap 0.54.1 + sklearn 1.9.1):** `TreeExplainer` runs
   on our model, but with native categorical features its values are **silently wrong** (they do
   not sum to the model output). Without categorical features they are exact (additive in log
   space, 0.1 s per 200 rows). ⇒ Phase 1 must re-encode weekday/category/store (numeric or
   one-hot), **re-measure accuracy**, and test additivity. Contributions are in log space (Poisson
   link): the UI must explain them as "pushes the forecast up/down by ×N", not as units.
2. **Promotions are invisible.** The generator multiplies demand by 1.6 on promotion days but
   stores no promotion calendar. An anomaly detector would flag every promotion as a spike, and the
   model cannot use them. ⇒ store a synthetic promotion calendar (`forecast.promotions`) and use it
   as a feature and as "known cause" for anomalies.
3. **No ground truth for anomalies.** ⇒ the generator injects **labelled** anomalies (spikes,
   drops, shrinkage) so precision/recall can be measured honestly.
4. **No supplier lead-time history.** ⇒ generate a labelled **synthetic PO history** (ordered /
   expected / received dates per supplier). Statistics yes; an ML lead-time model would be trained
   on labels we invented ourselves, so I recommend **not** building one (the brief itself forbids
   fabricated labels).
5. **Safety stock uses demand std, not forecast error.** Using both forecast error and historical
   demand std would double-count. V2 uses the forecast's own error distribution (from the
   backtest residuals) only.
6. **Resources:** 3.6 GB RAM in WSL; ~1.2 GB free while the full demo + observability run.
   Apache Superset's own docs ask for far more than that. MLflow (~250 MB) and Jaeger (~100 MB)
   fit; Superset realistically does not run next to the app.
7. **Ops-anomaly data:** adjustments/returns only exist from demos. Generating history for them must
   go **through the API** (simulator), never by inserting ledger rows — the simulator gets
   "suspicious behaviour" modes.

### 1.5 Architectural risks to manage

- **Ownership of ML outputs vs. human decisions.** Python may write detections/model candidates;
  review status, activation and rollback are human decisions and belong to the API (same pattern as
  forecasts → recommendations today).
- **Model activation changes behaviour.** Today each run re-selects baseline vs ML automatically.
  V2 "never silently replace a model" means a run produces a *candidate*; serving uses the *active*
  version until an authorized user activates the candidate. This needs persisted model artifacts.
- **Pickle safety:** model artifacts (joblib) are loaded only from the service's own volume, with a
  SHA-256 stored in the registry and checked before loading.
- **Scope creep:** the brief lists ~10 new pages and ~5 new services. Each phase below is shippable
  on its own, and optional services stay in compose profiles.

---

## 2. Decisions (D1, D2, D4 confirmed by the user on 2026-11-17; the rest are defaults)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | BI tool | ✅ **Grafana (already present) with a read-only Postgres datasource and SQL views**; Superset is not built | Superset needs more RAM than this machine has free; Grafana covers sales/inventory/forecast/supplier dashboards with no new service |
| D2 | Drift monitoring | ✅ **Own tested code (KS test + PSI with SciPy, already installed)**; no Evidently | Evidently adds a large, fast-changing dependency for two statistics; our code is ~150 lines and unit-testable |
| D3 | MLflow | **Yes, optional profile, mirror only.** PostgreSQL registry is the source of truth; forecasting works when MLflow is down | Matches "don't make the app depend on MLflow" |
| D4 | Model activation | ✅ **Manager-activated** (candidate must pass the gate; nothing switches silently) | The brief requires it; it changes today's auto-selection |
| D5 | Frontend tests | **Add Vitest + Testing Library** to `apps/web` | Needed for component/role-visibility tests; no runner exists |
| D6 | Supplier lead-time ML | **No** — statistics only (mean, median, std, on-time rate, reliability score) | Labels would be our own synthetic numbers |
| D7 | PDF reports | **Print stylesheet (browser "Save as PDF") + server CSV**; no headless-Chrome PDF service | Avoids a ~300 MB dependency |

---

## 3. Phased plan with acceptance criteria

Order differs slightly from the brief: a short **data foundation** step comes first, because
anomalies, intervals, ABC/XYZ and supplier statistics all depend on it.

### Phase 1 — ML intelligence

**1a. Data foundation and evaluation (Python)**
- Generator v2: synthetic promotion calendar → `forecast.promotions`; injected **labelled**
  anomalies → `forecast.injected_anomalies` (ground truth, clearly SYNTHETIC); same seed ⇒ same data.
- Backtest adds: forecast **bias** (Σ(ŷ−y)/Σy), metrics **per horizon**, interval **coverage** and
  **mean width**, under/over-prediction counts.
- Re-encode categorical features; add `promo_today` / `promo_in_window` features; re-measure.
- ✅ Accept: leakage tests still green; new metrics persisted per run; ARCHITECTURE §7.3 re-measured
  (old and new numbers side by side, including the noise floor).

**1b. Probabilistic forecast**
- Replace the symmetric normal band with **split-conformal intervals**: empirical quantiles of the
  validation residuals, by horizon bucket and volume bucket (low-volume series get their own band).
  Keep the 80 % level; add 95 % for safety stock.
- Evaluate coverage on the untouched test window; publish "nominal 80 % → measured X %".
- ✅ Accept: measured coverage within ±5 points of nominal on the test window, **or** the UI and docs
  state the measured coverage instead of the nominal one. Compare with today's band.

**1c. Explanations (SHAP)**
- `shap.TreeExplainer` on the re-encoded model; global importance per run (mean |SHAP|) and per
  series explanations for the forecast origin, stored in `forecast.explanations` (top features,
  values, contribution, model version). Wording: "contribution to the model's forecast", never
  "cause".
- ✅ Accept: additivity test (Σ contributions + base = model log-output, 1e-6); explanation endpoint +
  "Why this forecast?" panel on the product page.

**1d. Model comparison**
- Add a Random Forest **only if** the backtest shows a gain over hgb on validation; otherwise
  document the result and drop it. No deep learning.
- ✅ Accept: comparison table includes MAE, RMSE, WAPE, bias, coverage per model and split.

**1e. Anomaly detection**
- Sales anomalies (Python, daily per product × store): expected = robust baseline (median of the
  last 8 same weekdays, scaled MAD) → **robust z-score**; promotions are labelled "known cause".
  Compare against an IQR rule and an Isolation Forest on the same labelled data; ship the method with
  the best measured precision/recall (or the simplest if they tie).
- Operational anomalies (API, SQL over the ledger): unusual negative adjustments, return rate,
  shrinkage — simple, explainable rules with thresholds in config.
- Python writes detections to `forecast.anomaly_detections` (immutable). The API owns
  `anomaly_reviews` (NEW → INVESTIGATING → CONFIRMED / DISMISSED → RESOLVED), with who/when/note.
- Simulator gets `--mode=suspicious` (adjustment and return bursts, through the API).
- ✅ Accept: measured precision/recall on injected anomalies; nothing touches stock; store managers
  see only their stores; Anomalies page with review workflow; e2e covers one review.

### Phase 2 — Inventory optimization

- **ABC** by 365-day consumption value (units × primary unit cost), cumulative 80 / 95 / 100 %.
  **XYZ** by coefficient of variation of weekly demand (X < 0.5, Y 0.5–1.0, Z > 1.0), with
  intermittent demand (ADI > 1.32) forced to Z. Per product network-wide and per store.
  Table `inventory_classifications` (versioned by calculation run). Policies per class in a
  documented config file, shown on the page.
- **Safety stock v2:** `SS = z(SL) × √(L·σe² + d̄²·σL²)`; σe = forecast error per day from the
  conformal residuals; σL from supplier history (0 when unknown, stated). Service level
  configurable per ABC/XYZ class (90 / 95 / 97 / 99 %).
- **Supplier performance:** synthetic PO history generator (labelled), statistics view
  (mean / median / std lead time, on-time %, late %, reliability score); `GET /suppliers/performance`.
- **Replenishment v2:** new types `REDISTRIBUTE_EXCESS` (store → store/DC) and `MANUAL_REVIEW`
  (e.g. Z-class with too little history); expected stockout date; every input stored as today.
  "No action required" is shown on the product page, not stored as 1,000 rows.
- ✅ Accept: pure-function unit tests with hand-checked numbers for every formula; approval still
  required; 5 concurrent approvals still create one document.

### Phase 3 — ML lifecycle

- Registry in PostgreSQL: `forecast.model_versions` gains `status` (CANDIDATE / ELIGIBLE / ACTIVE /
  RETIRED / REJECTED), artifact path + SHA-256, training window, feature config, metrics link.
  Activation/rollback history in `model_activations` (API-owned, who/when/why).
- Forecast runs serve the ACTIVE version; a better candidate becomes ELIGIBLE, never ACTIVE by itself.
- MLflow (optional `mlops` profile, SQLite + local artifacts): runs, params, metrics, artifacts
  mirrored; the app works without it.
- Monitoring run (manual or daily timer): data drift (KS/PSI per feature, sales level per store),
  prediction drift, and **performance** on newly observed days (realized WAPE/bias vs backtest).
  Stale-forecast and failed-run alerts (operational, separate from model quality).
- ✅ Accept: rollback restores the previous artifact and is tested; drift tests with synthetic shifted
  data; Model Monitoring page; no automatic retraining.

### Phase 4 — Analytics

- **Control Tower** = the Overview evolved: KPI row (adds total on hand/available, pending transfers,
  open anomalies, excess value at cost), per-location health table, risk panel (7 d / 14 d, excess,
  delayed transfers, anomalies, supplier risk) with links, 4–5 charts. Same store scoping.
- **Scenarios:** stored parameters (demand ±%, lead time +days, DC availability −%) + baseline
  forecast run id; results computed with the same pure replenishment functions; compare 2–3
  scenarios. Tables `scenarios`, `scenario_results` only.
- **Reports:** daily/weekly, org-wide or per location, `report_runs` with JSON snapshot; CSV export;
  print-friendly page; generation timer in the API (configurable, off in tests).
- **BI:** per D1.
- ✅ Accept: a test proves running scenarios changes no row in ledger, balances, outbox, transfers or
  POs; reports show period + generated-at; Control Tower p95 measured.

### Step 4d — Grafana business dashboards: rules (written 2026-11-18, BEFORE building)

- Keep the existing Prometheus-backed **RetailPulse API** dashboard. Add a PostgreSQL datasource and
  four provisioned dashboards: **Sales**, **Inventory**, **Forecast quality**, and **Suppliers**.
  Every dashboard says the data is synthetic and states whether its numbers are historical or a
  current snapshot.
- Grafana queries only views in a new `reporting` schema. The fixed `retailpulse_grafana` database
  role gets `USAGE` on that schema and `SELECT` on those views, with no privilege on application or
  `forecast` tables and no write privilege anywhere. It is created `NOLOGIN` by the migration; the
  optional observability profile enables login with `GRAFANA_DB_PASSWORD` at startup, so no database
  password is committed.
- **Sales:** daily units and value by store/product/category from `forecast.demand_daily`; value uses
  the current catalog price, not a historical sale price. **Inventory:** current on-hand, reserved
  and available units and value at primary-supplier cost. **Forecast quality:** validation/test MAE,
  RMSE, WAPE, bias and measured 80/95% coverage by run/model, with the served model marked.
  **Suppliers:** deliveries, lead-time spread, on-time/fill rates and the existing reliability score
  (50% on-time + 30% fill + 20% lead-time consistency; no score below five deliveries).
- Dashboard filters are read-only Grafana variables (store/category/model/supplier as applicable).
  Business dashboards default to the last year; inventory is explicitly a live snapshot and ignores
  the time picker. Anonymous access remains localhost-only and Viewer-only.
- Checks: a real-database integration test proves all four views return seeded/inserted facts, the
  Grafana role can read every reporting view, and that role cannot read or write base tables. Validate
  provisioning files and dashboard JSON, then start the observability profile and verify both
  datasources and all five dashboards through Grafana's HTTP API.

### Phase 5 — Production engineering

- **OpenAPI:** generated from the existing Zod schemas (Zod 4 `toJSONSchema`) via a route registry,
  plus a test that fails if any Nest route is missing from it; served at `/api/v1/docs` for
  signed-in users. FastAPI's own docs documented as internal.
- **OpenTelemetry:** Node SDK (HTTP, Express, pg) + FastAPI instrumentation, W3C trace context
  API → Python, trace id joined to the correlation id; optional `tracing` profile (Jaeger).
  No bodies, cookies or credentials in spans.
- **Security review** with a written checklist and tests for every "verify that" item in the brief.
- **Performance:** extend `npm run measure` and the simulator; EXPLAIN-check new queries; record
  numbers.
- **Backup/restore:** `scripts/db/backup.sh`, `restore.sh` (into a *new* database, never over the
  current one), `npm run db:verify` (balance = Σ ledger, no negatives, outbox consistency).
- ✅ Accept: restore drill documented with measured timings; route-coverage test for OpenAPI.

### Step 5a — generated OpenAPI: rules (written 2026-11-18, BEFORE building)

- Add a small route registry in the API core. Every Nest HTTP handler has one registry entry with
  method, path, tag, summary, response status/content type and, where applicable, the exact Zod body
  or query schema already used by its controller. Zod 4 `toJSONSchema(..., { io: 'input' })`
  generates OpenAPI 3.1 request schemas; validation rules are not copied into decorators.
- Generate `/api/v1/openapi.json` plus a dependency-free HTML reader at `/api/v1/docs`. Both require
  a normal signed-in session (all four roles); login, logout, health and Prometheus metrics remain
  documented as public. The specification describes the `rp_session` cookie, `Idempotency-Key`,
  common error envelope, JSON/text/CSV responses and the exact non-prefixed `/metrics` path.
- Responses without an existing runtime Zod schema are documented by status and media type rather
  than inventing a second response model that could drift from the TypeScript interfaces. This step
  makes request contracts executable and route coverage complete; typed response schemas can be
  added incrementally when they also become runtime validators.
- A coverage test discovers the real Nest controller methods and compares method + internal path with
  the registry in both directions. A new route without a registry entry, a stale entry, or a duplicate
  operation/path fails CI. Tests also prove docs/spec are unauthenticated at 401, readable by a
  signed-in analyst, OpenAPI 3.1 structure is valid, Zod constraints/defaults appear, public/security
  markers are correct, and all operation IDs are unique.

### Step 5b — OpenTelemetry tracing: rules (written 2026-11-18, BEFORE building)

- Tracing is optional and disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Normal development,
  tests and the default/full Compose profile keep working without Jaeger or an exporter. The
  `tracing` profile adds one localhost-only Jaeger all-in-one container with its UI on port 16686 and
  OTLP/HTTP ingestion on the private Compose network.
- The API starts the OpenTelemetry Node SDK before Nest loads, with HTTP, Express and `pg`
  instrumentation. The forecasting service instruments FastAPI. Both export OTLP/HTTP,
  identify themselves as `retailpulse-api` and `retailpulse-forecasting`, and use W3C Trace Context.
- API calls to forecasting inject the active `traceparent` and forward the request correlation ID.
  Both services attach the safe correlation ID to the active server span and return `x-trace-id` for
  diagnostics. No request/response bodies, cookies, authorization values, database statements or
  credentials are added as custom attributes; URL query values are redacted by the API sanitizer.
- Tests prove tracing is a no-op without configuration, trace-context injection is valid, correlation
  IDs are joined to spans/response headers, and the forecasting middleware accepts/returns the same
  correlation ID. A live profile check must show one trace spanning API and forecasting in Jaeger,
  while stopping Jaeger must not stop either application service.

### Step 5c — security review: rules (written 2026-11-18, BEFORE building)

- Produce `docs/SECURITY-REVIEW.md`: threat model, an evidence-linked checklist, fixed findings,
  accepted local-demo risks and repeatable verification commands. It must not call the synthetic
  localhost demo production-ready or hide the trust boundaries around Grafana, Jaeger, MLflow,
  Prometheus and the internal forecasting service.
- Re-verify authentication and authorization: deny-by-default route metadata, anonymous rejection,
  role and store scope, scrypt password storage, server-side hashed sessions, expiry/logout,
  production cookie flags, login throttling and indistinguishable bad-login errors. Existing tests
  count as evidence; add a focused test for every uncovered behaviour.
- Treat `SameSite=Strict` as defence in depth. Reject unsafe browser requests when `Origin` does not
  match the effective host or Fetch Metadata says `cross-site`; keep non-browser/API clients that
  omit both headers operational. Do not enable permissive CORS.
- Add response hardening to the API and every Nginx response location. The application reader gets
  a per-response nonce CSP; the React app gets a restrictive CSP compatible with its existing
  inline style attributes. HSTS remains a TLS-terminator responsibility and is deliberately absent
  from the localhost HTTP demo.
- Re-verify validation, parameterized SQL, stable error envelopes, output escaping, secret/log/span
  hygiene and private service exposure. Add dependency-vulnerability checks to CI and record the
  clean audit result. Security checks must pass alongside the full unit, integration, forecasting,
  browser, build and Compose checks; no secret may be added to the repository.

### Phase 6 — Final verification and release notes (as in the brief).

---

## 4. Database changes (new migrations only; none edits an applied file)

| Migration (planned) | Contents |
|---|---|
| `0007_ml_intelligence.sql` | `forecast.promotions`, `forecast.injected_anomalies`, `forecast.anomaly_detections`, `forecast.explanations`, `forecast.model_metrics` + bias/coverage/width/horizon columns, `forecast.points` + `lower95/upper95`; API-owned `anomaly_reviews` |
| `0008_optimization.sql` | `inventory_classifications`, `classification_runs`, synthetic PO history flag on `purchase_orders` (`is_synthetic_history`), supplier performance view |
| `0009_model_lifecycle.sql` | model status/artifact columns, `model_activations`, `forecast.monitoring_runs` |
| `0010_analytics.sql` | `scenarios`, `scenario_results`, `report_runs`, read-only role + reporting views |

The Python write-guard test is extended to the new `forecast.*` tables only; it must still fail on
any write outside `forecast`.

## 5. API contracts (adapted to existing conventions)

| Area | Endpoints | Roles |
|---|---|---|
| Anomalies | `GET /anomalies`, `GET /anomalies/:id`, `POST /anomalies/:id/review` (status + note) | read: all (store-scoped); review: admin, inventory mgr, store mgr (own store) |
| Forecasts | existing `GET /forecasts/series` gains intervals + `GET /forecasts/explanation?productId&locationId`; `GET /forecasts/metrics` | read roles |
| Classifications | `GET /classifications`, `POST /classifications/recalculate` | read / approvers |
| Suppliers | `GET /suppliers/performance`, `GET /suppliers/:id/performance` | read roles |
| Models | `GET /ml/models`, `POST /ml/models/:id/activate`, `POST /ml/models/:id/rollback`, `GET /ml/monitoring`, `POST /ml/monitoring/run` | admin + inventory mgr for writes |
| Scenarios | `POST /scenarios`, `GET /scenarios`, `GET /scenarios/:id`, `POST /scenarios/:id/run` | approvers (create/run), read roles |
| Reports | `GET /reports`, `POST /reports/generate`, `GET /reports/:id`, `GET /reports/:id/export.csv` | read roles, store-scoped |
| Control Tower | `GET /overview` extended (one call); `GET /overview/locations` | read roles |

I removed the brief's duplicates: `/forecasts/:productId/:locationId` already exists as
`/forecasts/series`, and a separate `/control-tower/*` would duplicate `/overview`.

## 6. Testing plan

- Python: leakage (existing), conformal coverage on synthetic data with known distribution, SHAP
  additivity, anomaly precision/recall on injected labels, drift tests with shifted data,
  registry/rollback, write guard.
- API: pure-function tests for ABC/XYZ, safety stock, scenarios; integration tests per endpoint
  (auth, store scope, validation, "writes nothing" for scenarios/overview/reports).
- Web: Vitest + Testing Library for role-based visibility and loading/empty/error states.
- E2E: the brief's 9-step flow (login → Control Tower → risk → forecast → explanation →
  recommendation → approve → transfer → stock updated) + "scenario changes nothing".
- Every phase ends with `npm run check`, `npm run test:int`, `npm run forecast:test`,
  `npm run test:e2e`, and measured numbers in the README.

## 7. Resource plan

Core demo stays as today (~450 MB). Optional profiles, never all at once on this machine:
`observability` (+~120 MB), `mlops` (MLflow, ~250 MB), `tracing` (Jaeger, ~100 MB).
New Python dependencies: `shap` (plus `numba`/`llvmlite`, ~150 MB in the image).

## 8. Size estimate

Roughly: Phase 1 ≈ 3 sessions, Phase 2 ≈ 2, Phase 3 ≈ 2, Phase 4 ≈ 2–3, Phase 5 ≈ 2,
Phase 6 ≈ 1. Each phase ends in a commit with its report (brief Part 12).

---

## 9. Progress log

### Step 1a — data foundation ✅ (2026-11-17, commit 4ccd5d2)

- Migration `0007_forecast_foundation.sql`: `forecast.promotions`, `forecast.injected_anomalies`,
  `forecast.horizon_metrics`; `bias`, `interval_coverage`, `interval_width` on `model_metrics`.
- Generator stores the promotion calendar and injects labelled anomalies (73 spikes + 78 drop days
  in the dev data) on a separate random stream.
- Evaluation adds bias, per-horizon metrics, and test-window coverage/width of the 80 % range
  built from validation errors only.
- Model: category/store as numeric codes (SHAP-safe), promotion-calendar features; model version
  `hgb_direct` 2. `npm run forecast:measure` reproduces the numbers.
- Measured (ARCHITECTURE §7.3): test WAPE **51.6 %** (Day 6 model on the same data 52.2 %, best
  baseline 54.4 %, noise floor 51.0 %); bias +0.1 %; 80 % range covers 83.4 %.
- Tests: Python 56 → 66; TypeScript unchanged and green (119 + 202), e2e green.

### Step 1b — probabilistic forecast ✅ (2026-11-17, commit 43582e0)

- Diagnosis: the Day-6 "80 %" band (± 1.28 σ) held 83.4 % overall but 91 % for slow sellers and
  78 % for fast ones.
- New `evaluation/intervals.py`: split-conformal 80 % and 95 % ranges, grouped by forecast level,
  calibrated on validation and checked on test; live ranges use both windows.
- Migration `0008_forecast_ranges.sql`: 95 % range on points (nested CHECK), 95 % coverage/width,
  `forecast.interval_calibration` (quantiles + honest test coverage per level group).
- API: bias, coverage and per-level calibration in `/forecasts/runs/latest`; 95 % range and
  calibration in `/forecasts/series`.
- UI: chart shows 80 % and 95 % bands; the product page states the range in words with its measured
  reliability; the accuracy card adds bias, coverage and a per-level reliability table.
- Measured (dev data, served model, test window): 80 % range held **80.0 %**, 95 % held **94.9 %**;
  every level group 78.5–84.2 % / 93.8–95.7 %; 80 % range narrower than before (4.94 vs 5.09 units).
- Tests: Python 66 → 73, API integration 202 → 204; all checks and e2e green.

### Step 1c — explanations (SHAP) ✅ (2026-11-17, commit 4a46ac0)

- `shap==0.54.1` (adds shap, slicer, tqdm; ~5 MB). `app/models/explain.py`: TreeExplainer on the
  served model; additivity checked per run (measured error ~1e-15); a non-additive result stores
  nothing (`explanation_status = FAILED_CHECK`) — proven by a test with the Day-6 encoding.
- Migration `0009_forecast_explanations.sql`: `forecast.explanations` (first forecast day per
  series, contributions as JSON), `forecast.feature_importance`, `runs.explanation_status`.
- API: `GET /forecasts/explanation` (store-scoped; factors with labels and readable values, or the
  reason there is none) and `importance` in `/forecasts/runs/latest`. Labels are a tested pure
  function (`forecasts.explain.ts`).
- UI: "Why this forecast?" on the product page (starting point × top 5 factors × the rest, with
  bars; works at phone width) and "What does the model rely on most?" on the accuracy card.
- Measured on the dev data: 950 series explained; most relied-on inputs: 56-day average (0.585),
  weekday (0.124), 28-day average (0.047), time of year, promotion planned. Run time unchanged
  (34-39 s).
- Fixed on the way: the product page said "Tomorrow" for the first forecast day, which is the day
  after the history ends (today, when the history ends yesterday); it now shows the date.
- Tests: Python 73 → 77, API unit 119 → 124, API integration 204 → 206; all checks and e2e green.


### Step 1d — model comparison: decision rule (written 2026-11-17, BEFORE any measurement)

Candidate: scikit-learn `RandomForestRegressor`, same features and training rows as `hgb_direct`,
fixed settings chosen before measuring and sized for this 3.6 GB machine: 150 trees,
`min_samples_leaf=50`, `max_features=0.5`, `max_samples=0.3` (each tree sees 30 % of the rows),
squared-error criterion. No tuning on validation or test. To show what "noise" means, the same
report also trains `hgb_direct` with a second seed (43).

The Random Forest joins the production model selection **only if** its **validation** WAPE is at
least **0.5 points** lower than `hgb_direct`'s on the same data (a smaller gap is within run-to-run
noise and not worth a second model). The test window is reported but never used to decide.
If it does not pass, it is documented here and in ARCHITECTURE §7.3 and is **not** added to
production; the comparison stays reproducible with `npm run forecast:measure -- --candidates`.

### Step 1d — model comparison: result ✅ (2026-11-17, commit 1bab93c)

- `app/evaluation/compare.py`: candidates are scored on exactly the production protocol (a test
  proves gradient boosting scored here equals the pipeline's numbers); `decide()` applies the rule
  above (tested at its boundary, and that the test window is ignored).
- Measured: production 50.9 % validation / 51.6 % test WAPE; second seed 51.0 / 51.6 (noise 0.15
  points); Random Forest 51.4 / 52.1, bias +2.3 %, 132 s vs 25 s. **Random Forest does not pass** —
  it is 0.52 points worse on validation. Production is unchanged.
- Tests: Python 77 → 85. Nothing in the API or UI changed (the accuracy card already shows WAPE,
  MAE, bias and range coverage per model and window).


### Step 1e — split (decided 2026-11-17)

1e is two pieces of work, built and approved separately:

- **1e-1** sales-anomaly detection in the forecasting service: methods compared on the labelled
  anomalies from 1a, precision/recall measured, detections stored with every forecast run.
- **1e-2** the review workflow (API-owned statuses NEW → INVESTIGATING → CONFIRMED / DISMISSED →
  RESOLVED), the Anomalies page, operational anomalies (adjustments, returns) and a simulator mode.

### Step 1e-1 — detection rules (written 2026-11-17, BEFORE any measurement)

Per product × store × day, the **expected** sales are the median of the same weekday over the
previous 8 weeks (strictly before the day; promotion days excluded), multiplied by the day's planned
promotion uplift (a promotion is a known cause, not an anomaly). Days with < 4 usable past values
are not judged.

- **Robust z (main candidate):** z = (actual − expected) / scale, scale = max(1.4826 × MAD of
  those weeks, √expected, 1) — the √expected floor stops low-volume series from flagging every
  extra unit. SPIKE if z ≥ **5**.
- **IQR rule (comparison):** SPIKE if actual > Q3 + **3** × max(IQR, 1) of the same weeks.
- **Isolation Forest (comparison):** scikit-learn, 200 trees, `contamination=0.001` (a generic
  "rare" setting, not the true label rate), on [actual, expected, actual − expected, z, weekday].
- **DROP (all methods):** 3 consecutive days of zero sales whose expected total is ≥ **7** units
  (Poisson chance of three zero days ≤ e⁻⁷ ≈ 0.1 %).

Severity: HIGH if z ≥ 10 (or a drop with expected total ≥ 14), else MEDIUM.

Scoring: precision and recall against the injected labels on days with ≥ 8 weeks of history, on the
dev data (seed 42) **and** a second dataset (seed 7) to check the result is not a fluke. Naturally
rare sales that were not injected count as false positives — that is the honest cost of a
threshold. **Choice rule:** ship the method with the highest F1 on seed 42 only if it also has the
highest F1 on seed 7; otherwise ship the robust z (the simplest to explain). Thresholds are not
changed after seeing results.

### Step 1e-1 — result of rule v1, and rule v2 (written 2026-11-17, BEFORE measuring v2)

**v1 measured** (`--anomalies`): recall was good (robust z 78 % / 83 % on seeds 42 / 7) but precision
was 3.5 % — 1,276 flags for 58 real spikes. Isolation Forest had the best F1 on seed 42 but not on
seed 7, so the v1 rule would ship robust z. Drops: F1 45 % / 32 %.
**Diagnosis:** on the false-alarm days the true expected demand was 1.9× the baseline: the median of
small counts sits below their mean, and √expected understates the spread of this over-dispersed data.
A detector that knew the true demand would still raise 86 false alarms at z ≥ 5 (the floor of
unavoidable randomness); the other ~1,145 came from the baseline.

**v2 (one revision, no further tuning):** expected = mean of the past same-weekday values after
dropping the single largest (so one past spike cannot inflate it), × the promotion uplift;
scale = √max(expected, variance of those values), at least 1. Threshold (z ≥ 5), drop rule,
severity and the comparison methods are unchanged.
**Confirmation:** seeds 42 and 7 have now been looked at, so v2 is judged on a fresh dataset,
**seed 99**: ship v2 if its spike precision is higher than v1's there and its recall is at most
10 points lower; otherwise ship v1 and say so. Numbers for 42 and 7 are reported as development data.

### Step 1e-1 — result ✅ (2026-11-17, commit ac217d8)

- **v2 failed its held-out check** on seed 99: spike precision 3.7 % vs v1's 4.2 % (it flagged
  more days: trimming the largest value lowered the baseline again). As written in advance,
  **v1 ships**; no further revisions.
- Shipped (v1), seed 99: spikes 4.2 % precision / 83.6 % recall overall; **HIGH spikes 47.4 % /
  13.4 %** (dev seeds 57.9 % and 80.0 %); drops 19.7 % / 92.3 %. ~280 MEDIUM and 2–4 HIGH spike
  findings per 90 days on the dev data.
- Base rate: injected spikes are 0.02 % of product-days; a detector that knew the true demand would
  still raise 86 false alarms vs 58 real spikes (seed 42). So 1e-2 must lead with HIGH findings and
  show the measured precision of each level.
- Migration `0010_anomaly_detections.sql`; findings of the last 90 days are stored at the end of each
  forecast run (never rewritten; a later run skips known ones — tested). Detection takes 0.6 s
  (the IQR comparison's quartiles, 15 s, are only computed when that method is measured).
- Tests: Python 85 → 94; TypeScript suites unchanged and green.

### Step 1e-2 — review workflow and operational anomalies ✅ (2026-11-18, commit b0a8559)

- Migration `0011_anomaly_reviews.sql`: `operational_anomalies`; `anomaly_reviews` with a transition
  trigger (only the allowed steps; DISMISSED and RESOLVED final); append-only
  `anomaly_review_events`; view `anomaly_findings` over sales and operational findings.
- API module `anomalies`: `GET /anomalies` (filters, HIGH first, store-scoped), `GET /anomalies/:id`
  (history + allowed next steps), `POST /anomalies/:id/review` (note required to confirm, dismiss or
  resolve). Event consumer `operational-anomalies` with three plain rules (pure, unit-tested).
- UI: **Unusual activity** page (filters; numbers in words; status) and a detail page (explanation,
  how much to trust it, review buttons with a note, history). Fits a phone screen.
- `npm run sim:suspicious` (also part of `npm run demo`) creates the three patterns through the API.
- Verified end to end: the simulator's write-off, corrections and returns became 3 findings within
  seconds; reviewed in the browser (new → investigating → confirmed, with note).
- Two older event tests assumed one consumer; they now check the alerts consumer's own marks.
- Tests: API unit 124 → 130, integration 206 → 218, e2e 1 → 2 (a write-off is found and
  investigated through the UI); Python unchanged (94). All green.
- Note for running two API versions: an older API's event worker on the same database would mark
  new events done without the new consumer. The Docker demo was rebuilt with this code.


### Step 2a — ABC/XYZ rules (written 2026-11-18, BEFORE any calculation)

Data: `forecast.demand_daily` (units sold per product × store × day; synthetic history plus real
ledger sales), the last **52 full weeks** ending on the latest day with data. Two scopes: the
whole network (per product) and each store (per product at that store).

- **ABC — value.** Consumption value = units sold × the primary supplier's unit cost (what the
  stock costs us; selling price only if a product had no cost — none has today). Sort by value,
  highest first; **A** = the products that make up the first **80 %** of total value, **B** = the next
  **15 %** (up to 95 %), **C** = the rest, including products that sold nothing. A product is A if the
  cumulative share *before* it is below 80 % (so the product that crosses the line is A).
- **XYZ — predictability**, from weekly units (weeks remove the weekday pattern):
  coefficient of variation CV = standard deviation ÷ mean of the weekly units, and the average
  demand interval ADI = weeks ÷ weeks with any sale. **X** CV ≤ 0.5, **Y** 0.5 < CV ≤ 1.0, **Z** CV > 1.0;
  intermittent demand (ADI > 1.32, the Syntetos–Boylan cut-off) or no sales at all is always **Z**.
- **NEW** — fewer than **13 weeks** of history: not classified (too little data to judge).
- Policies per class are documented text in a config file and shown on the page; service levels
  per class are decided in step 2b, not here.
- Recalculated on demand (admins / inventory managers), by `npm run demo`, and once a day by the
  API's background timer. Every run is stored with its window, so results are reproducible.

### Step 2a — ABC/XYZ classification ✅ (2026-11-18, commit f979b0a)

- Rules as written above, implemented as pure functions (`classifications.calc.ts`, 9 unit tests
  with hand-checked numbers). One edge found by the tests: a share of exactly 80 % was misread
  through float rounding; the comparison now has a 1e-9 tolerance.
- Migration `0012_classifications.sql`: `classification_runs`, `inventory_classifications`
  (class must equal ABC + XYZ, or NEW — enforced by the database).
- API: `GET /classifications`, `GET /classifications/summary`, `POST /classifications/recalculate`
  (approvers); daily background run; part of `npm run demo`.
- UI: **ABC/XYZ** page — 3 × 3 matrix (count and value share), click a cell for its products and
  the suggested policy; network or one store; fits a phone screen.
- Measured on the dev data: network AX 104 / BX 50 / CX 34 / CY 2 / NEW 10; STR-01 shows all classes
  but AZ and BZ. The synthetic data has almost no erratic demand (documented as a limitation).
- Tests: API unit 130 → 139, integration 218 → 223; all checks and e2e green. Navigation now wraps
  to two lines on desktop (11 items) — to be reorganised with the Control Tower (4a).


### Step 2c — supplier performance rules (written 2026-11-18, BEFORE generating or measuring)

Order: the user approved doing 2c before 2b, so safety stock (2b) can use measured lead-time
variation instead of assuming none.

**Data.** There is no delivery history yet (no purchase orders exist). So:
- `supplier_deliveries` holds one row per delivery: supplier, product, store, ordered on, promised
  lead time, received on, ordered and received quantity, and `source` = `SYNTHETIC` or `ORDER`.
- `npm run db:seed` fills **12 months of SYNTHETIC deliveries** (labelled, deterministic) for every
  primary supplier-product pair, about one order every 4 weeks to a random store. Each supplier has a
  fixed, documented profile — the "truth" the statistics must recover:
  Greenfield Fresh: almost always on time (delay 0 in 90 %, else +1 day), 2 % short shipments;
  Harbor Provisions: usually on time (75 % on time, else +1–3 days), 5 % short;
  Summit Household: often late (50 % on time, else +1–6 days), 10 % short (60–95 % of the order).
- A **real** purchase order adds a row (`ORDER`) when it is received. Synthetic history never
  creates purchase orders or stock movements — it is history, not stock.

**Statistics** (per supplier, and per supplier × product; plain arithmetic, no ML — decision D6):
deliveries; lead time mean / median / standard deviation (days from order to receipt); on-time rate
(received no later than ordered + promised days); late rate; average days late when late; fill rate
(received ÷ ordered units). **Reliability score** (0–100) = 50 × on-time rate + 30 × fill rate +
20 × (1 − min(lead-time CV, 1)). Fewer than 5 deliveries → shown, but marked "too few to judge".

**Check:** the measured on-time rates must put the suppliers in the profile order (Greenfield >
Harbor > Summit), and each supplier's measured on-time rate must be within 10 points of its profile.

### Step 2c — supplier performance ✅ (2026-11-18, commit 7e20a3b)

- Migration `0013_supplier_deliveries.sql` (immutable rows; SYNTHETIC or ORDER). The seed adds 2,601
  synthetic deliveries once, from its own random stream (catalog and stock unchanged; re-seeding adds
  nothing — tested). Receiving a purchase order adds one ORDER row per line, in the same transaction.
- API module `suppliers`: `GET /suppliers/performance`, `GET /suppliers/:id/performance`
  (statistics in SQL; reliability score pure and unit-tested).
- UI: **Suppliers** page and detail page (per product, latest deliveries); fits a phone screen.
- **Pre-registered check passed:** measured on-time 89.7 / 75.7 / 52.8 % vs profiles 90 / 75 / 50 %,
  ranked correctly. Scores 86 / 81 / 69.
- Finding for 2b: per-product statistics from 12–15 deliveries are noisy (23–86 % on time for one
  50 % supplier) — use the supplier-level lead-time spread unless a product has many deliveries.
- Tests: API unit 139 → 143, integration 223 → 227; all checks and e2e green. One lint false
  positive (a pipe used only in a decorator) fixed by inlining it like the other controllers.



### Step 2b — safety stock rules (written 2026-11-18, BEFORE any calculation)

Replaces today's `SS = 1.645 × σ_demand × √L` (one service level for everything, the spread of
*demand* instead of the forecast's *error*, and lead times treated as exact).

```text
SS = z(SL) × √( L̄ · σe² + d̄² · σL² )
```

- **σe — forecast error per day** = `forecast.series.sigma`: the served model's root-mean-square
  daily error over the validation and test windows (the same residuals that calibrate the conformal
  ranges, ~56 origins × 7 horizons per series). Fallback series keep their category-average spread
  (flagged as today). Not the spread of demand (`std_daily_90`): the forecast already follows the
  weekday pattern, promotions and trend, so counting that variation again would double it.
  Assumption stated with the result: daily errors are independent, so they add up as L̄ · σe².
- **d̄** = average forecast units per day over the lead time (as today).
- **L̄ and σL — lead time.** Purchase orders: L̄ = the lead time the supplier promises for this product
  + the supplier's **mean delay**; σL = the standard deviation of the supplier's **delay**
  (delay = actual lead time − promised, per delivery, all products and stores of that supplier).
  Delay rather than raw lead time, because promised lead times differ between a supplier's products
  (step 2c's "11.1 ± 3.8 days" mixes them). Supplier level, not per product: per-product samples of
  12–15 deliveries were measured as too noisy in 2c. A supplier with fewer than **20** deliveries:
  L̄ = promised, σL = 0, and the recommendation says "no delivery history". L̄ is also the lead time
  for forecast demand during the lead time and for the risk check, so reorder point and safety stock
  use the same lead time. The purchase order's expected date stays the supplier's promise.
  Transfers from a distribution centre: L = 2 days, σL = 0 (no measured transfer history; stated).
- **Service level per class** — the product's class **at that store** in the latest ABC/XYZ run
  (2a). Value decides how costly a stock-out is relative to holding stock; erratic (Z) demand gets
  one step less, because its safety stock is the largest and the normal approximation is weakest
  there (matches the 2a policies "avoid overstocking" / "review whether to stock at all"):

  | | X | Y | Z |
  |---|---|---|---|
  | **A** | 99 % | 99 % | 97 % |
  | **B** | 97 % | 97 % | 95 % |
  | **C** | 95 % | 95 % | 90 % |

  NEW or not classified yet: 95 % (today's level). z from a fixed table (90 % 1.2816, 95 % 1.6449,
  97 % 1.8808, 99 % 2.3263), configurable in `replenishment.config.ts`.
- Every input (σe, d̄, L̄, σL with its basis and delivery count, class, service level, z, and the two
  variance parts) is stored with the recommendation and written into its explanation.

**Checks, fixed now:**
1. Unit tests with hand-checked numbers for the formula, the class → service level table, both
   lead-time bases and both σ = 0 edge cases.
2. A seeded simulation test: under the formula's own assumptions (normal daily errors, normal lead
   time), the share of lead times covered by d̄·L̄ + SS is within **±1 point** of 90 / 95 / 99 %.
   This checks the implementation, not reality.
3. Measured on the dev data, v1 vs v2 for every product × store, reported as found (no target):
   total safety stock in units and at cost, per class and per supplier; median σe ÷ σ_demand
   (expected below 1); share of the variance that comes from lead time, per supplier (expected
   largest for Summit Household, the least punctual supplier).

Not claimed: that the service levels are achieved in practice — that needs a replay of past
lead-time demand against past forecasts, which belongs to the scenarios / monitoring steps.

### Step 2b — safety stock v2 ✅ (2026-11-18)

- Rules as written above. Pure functions in `replenishment.calc.ts` (`safetyStock`,
  `serviceLevelFor`, `supplierLeadTime`; `demandOver` now counts part of a day in proportion);
  service-level table in `replenishment.config.ts`. No migration: σe is `forecast.series.sigma`
  (already stored per run), delays come from `supplier_deliveries` (2c), classes from the latest
  ABC/XYZ run (2a). Replenishment now calls `SuppliersService.delays()` and
  `ClassificationsService.latestStoreClasses()` (two new arrows in the module map, no cycles).
- Every input is stored with the recommendation and explained in words; the detail page shows σe,
  the lead-time basis and spread, and the class service level. Older recommendations still display
  (their `sigmaDaily` is shown as before).
- **Checks.** (1) Hand-checked unit tests for the formula, all 9 classes + NEW/none, both lead-time
  bases, early suppliers and the σ = 0 cases. (2) Seeded simulation: covered share within ±1 point
  of 90 / 95 / 99 % — passed. (3) Measured on the dev data, 1,000 product × store pairs, supplier
  route, an independent re-statement of the formulas (not the API code):

  | Safety stock, total units | v1 | σe only | + measured lead time | v2 (+ class service level) |
  |---|---:|---:|---:|---:|
  | All pairs | 7,272 | 6,949 (−4 %) | 8,388 (+15 %) | **10,790 (+48 %)** |

  Per class (v1 → v2): AX 4,483 → 7,347 (+64 %), BX 1,468 → 1,901 (+30 %), CX 669 → 778 (+16 %),
  CZ 52 → 52 (0 %). Supplier delays: Greenfield +0.10 ± 0.30 days, Harbor +0.50 ± 0.98, Summit
  +1.64 ± 2.11 (n = 1,039 / 930 / 632). Share of the variance from lead time: Greenfield 8.5 %,
  Harbor 28.3 %, **Summit 37.0 %** — largest for the least punctual supplier, as expected.
  Median σe ÷ σ_demand = **0.97** (below 1 as expected, but only just; 62 % of pairs below 1): on
  this synthetic data the forecast removes little of the day-to-day spread, so switching to σe
  alone changes little; most of the increase is the 99 % policy for A items.
- End to end on the dev data (API on 3200): generating gave 269 transfer recommendations (v1: 259);
  one checked by hand against the database (AX → 99 %, z 2.3263 × σe 2.3239 × √2 = 7.645 ✓). The
  Docker demo was rebuilt with this code.
- Not claimed: that the service levels are achieved in practice (needs a replay of past lead-time
  demand — scenarios / monitoring). Limitation: delays are per supplier, not per product; transfers
  assume an exact 2-day lead time.
- Tests: API unit 143 → 165, integration 227 → 228 (class → service level through the API, measured
  supplier delay on the purchase-order path); Python unchanged (94); all checks and e2e green.


### Step 2d — split (decided 2026-11-18)

2d is three changes that each touch the database, the calculation, approval and the UI, so it is
built and approved in two parts:

- **2d-1** expected stockout date, manual review, and "no action required" on the product page.
- **2d-2** `REDISTRIBUTE_EXCESS`: moving excess stock from a store to another store or a DC.

### Step 2d-1 — rules (written 2026-11-18, BEFORE building or measuring)

**Expected stockout date** (per product × store, from the latest forecast run; day 1 = the first
forecast day = the day after the last complete day of data):
- Available ≤ 0 → **out of stock now**.
- Otherwise the first day *k* on which the cumulative forecast from day 1 to *k* is greater than the
  position (available + inbound — the same position as reorder point and days of cover, so it
  assumes inbound stock arrives in time). Stockout date = last data day + *k*.
- Beyond the forecast horizon the horizon's average per day is used (as for lead-time demand) and
  the date is marked "estimate beyond the forecast"; nothing is shown beyond **90 days**
  ("not within 90 days"), nor when no demand is forecast.
- Stored on every recommendation (`expected_stockout_on`) and shown in the list and detail.

**Manual review** — a flag on a recommendation (`review_reason`), not a third action type: a
reviewed suggestion still needs a source (DC or supplier) to become a transfer or order, and the
database rule "a transfer has a source, an order a supplier" stays as it is. A recommendation is
flagged when the automatic quantity is the least trustworthy:
- `FALLBACK_FORECAST` — the forecast is the category-average fallback (under 56 days of history);
- `ERRATIC_DEMAND` — the product's class at the store is Z (AZ, BZ, CZ), where the safety-stock
  formula's normal approximation is weakest (2b).
  If both apply, the fallback reason is stored (it is the more basic problem).
Flagged recommendations are calculated exactly like the others, but approving one **requires the
manager to enter the quantity and a note** (the suggestion is pre-filled); unflagged ones are
approved as suggested and refuse a quantity (422), as today. Every approval stores the quantity
actually approved (`approved_quantity`). Rejecting is unchanged.

**"No action required" on the product page** — not stored. A new read-only endpoint
`GET /replenishment/status?productId=` evaluates every store of that product **now** with the same
pure calculation as generation (current stock, latest forecast, class, supplier delay, DC stock) and
returns per store: position, reorder point, days of cover, expected stockout date, review flag, the
outcome (NO ACTION REQUIRED / NEEDS STOCK / NO SOURCE) and the pending recommendation if one
exists. Store managers see their own stores only. It writes nothing (tested).

**Checks:** hand-checked unit tests for the stockout day (flat and uneven forecasts, beyond the
horizon, the 90-day cap, out of stock now, no demand) and for both review reasons; integration tests
for approving with and without a quantity, the status endpoint (scope, writes nothing, agrees with
a generated recommendation for the same pair) and 5 concurrent approvals of a flagged
recommendation creating one document. Measured on the dev data, reported as found (no target): how
many recommendations are flagged per reason, and the spread of expected stockout dates.

### Step 2d-1 — stockout date, manual review, "no action required" ✅ (2026-11-18)

- Rules as written above, with one correction found on real data: "out of stock now" was first
  dated the last day of data (yesterday); it is now dated the first forecast day (today), with a
  test that fails on the old behaviour. The quantity errors are `422` (state-dependent, as in
  `sales`), not `400` as first written.
- Migration `0014_replenishment_review.sql` (`expected_stockout_on`, `review_reason`,
  `approved_quantity`; approved quantity only on APPROVED rows). Pure `stockoutDay`, `dayToDate`,
  `reviewReason` in `replenishment.calc.ts`; generation and the new status view share one
  `evaluatePair`. `plan()` now returns the reorder point when nothing is needed.
- API: `GET /replenishment/status?productId=` (read-only, store-scoped); `needsReview` filter;
  approve takes `quantity` (required with a note when flagged, refused otherwise).
- UI: list shows a Needs review badge, an Expected stockout column and a Review filter; the
  detail page explains the flag and asks for quantity and note; the product page gets
  **Replenishment by store** (no action required / needs stock, position, reorder point, expected
  stockout, pending recommendation). No new horizontal overflow (the product page's phone overflow
  is older: 547 px with or without the panel — still an open follow-up).
- Measured on the dev data (269 pending after generating): **23 flagged** — 17 fallback forecast,
  6 erratic demand; expected stockout: 127 out of stock now, the rest on forecast days 1–6
  (as expected, recommendations exist only below the reorder point). Status view vs generation,
  all 200 products × 5 stores: 269 needs stock / 731 no action required, **0 disagreements**, same
  quantities and flags; slowest call 174 ms.
- Tests: API unit 165 → 183, integration 228 → 231 (plus new assertions in existing tests:
  approving with/without quantity, 5 concurrent approvals of a flagged item → one document, status
  view writes nothing and matches the pending recommendation); Python unchanged (94); all checks
  and e2e green. Docker demo rebuilt.


### Step 2d-2 — excess redistribution rules (written 2026-11-18, BEFORE building or measuring)

**Excess** uses the Overview's existing definition (more than 60 days of cover), so both pages
agree. For a product at a store:
- keep = the larger of forecast demand over the next **60 days** (beyond the horizon at its
  average) and the store's own reorder point (supplier route) — *amended before building: with
  60 days alone, a slow seller with a long supplier lead time could be both "excess" and "needs
  stock"*. A store is a source only if it needs nothing itself;
- excess = position (available + inbound) − keep;
- **movable** = min(excess, available − units already promised to open outgoing transfers),
  rounded **down** to whole packs. Only stock that is physically there can move.
- Not a source of excess: recommendations flagged for review in 2d-1 (fallback forecast or Z-class
  demand — the forecast is least reliable) and products with no demand forecast at that store.
- Nothing is moved below 1 pack.

**Use 1 — store to store (needs first).** When a store needs stock (unchanged rules), the source is
chosen in this order: another store's movable excess if it covers the **whole** quantity (the
store with the most), then a DC (as today), then the supplier. A store-to-store move is a normal
`TRANSFER` whose source is a store, with the same 2-day lead time as from a DC (assumption,
stated). The units are taken out of that store's movable excess for the rest of the batch.

**Use 2 — back to a DC.** Movable excess left after all needs → a new action
**`REDISTRIBUTE_EXCESS`**: the recommendation belongs to the store with the excess and names a
destination DC — the DC holding the **least** available stock of that product (where it is most
useful; ties by code). No stockout risk (`risk` is empty for this action only).

**Approval** (admin / inventory manager, as for every recommendation): creates an APPROVED
transfer from the store; stock moves only when it is dispatched and received. Quantity as
suggested (these are never flagged for review). The product page's status view shows
**EXCESS** with the movable units when a store has some.

**Checks:** hand-checked unit tests (keep, excess, movable with packs / promised stock /
exclusions, source order, DC choice); integration tests: store → store sourcing, an excess →
DC recommendation whose approval creates one approved store → DC transfer and moves no stock,
5 concurrent approvals → one document, the database refuses inconsistent rows, and no source
store is ever planned below its keep level. Measured on the dev data, reported as found: number,
units and value at cost of excess moves; how many needs were covered from store excess instead of
a DC; movable units vs the Overview's 714 excess units (expected lower: whole packs, available
only, exclusions).

### Step 2d-2 — excess redistribution ✅ (2026-11-18)

- Migrations `0015_redistribute_action.sql` and `0016_redistribute_excess.sql` add the third action,
  its destination DC, nullable risk for excess only, and database checks for all three action
  shapes. Store-to-store sourcing remains a normal `TRANSFER`.
- Generation first calculates eligible movable excess, uses it for whole store needs before DC
  stock, then suggests moving the remainder to the least-stocked DC. Existing outgoing transfers
  are excluded, allocations are not promised twice, and fallback / Z-class / zero-demand stores
  are explicitly tested as ineligible. Approval creates one approved transfer under concurrency
  and moves no stock until dispatch/receipt.
- UI: Replenishment filters, generation summary, list/detail explanation, product-by-store status,
  and Overview all show excess moves. The detail page separates the keep-level calculation from a
  normal replenishment calculation; a null risk is displayed as **Excess**, not as a stockout.
- Measured on the current synthetic dev data (1,000 product × store pairs): **25** excess-to-DC
  suggestions, **336 units**, **1,156.60** at primary-supplier unit cost; **5** store needs
  (**66 units**) were covered from another store's excess. Total movable excess was **402 units**
  versus the Overview's **714 surplus units** (56 %), lower as expected because movable stock is
  available now, unpromised, in whole packs, and excludes uncertain forecasts.
- Tests: API unit 194; integration 232 → 233 (including the new exclusion case); Python unchanged
  at 94. Formatting, lint, typecheck, both builds and the browser e2e are green; API and web Docker
  images rebuilt.

### Step 3a — model registry and manager activation rules (written 2026-11-18, BEFORE building)

This is the first ML-lifecycle slice. Trained artifact persistence, drift/performance monitoring and
optional MLflow are separate later slices; this step makes the model policy real and auditable.

- Registry states: `CANDIDATE`, `ELIGIBLE`, `ACTIVE`, `RETIRED`, `REJECTED`. Exactly one model may
  be ACTIVE. Fallback (`category_average`) is per-series policy and cannot be activated globally.
- Forecast runs still evaluate every production candidate on the same time-ordered windows, but
  **serve the ACTIVE model**. They never switch because a new run measured a better candidate.
  If an ACTIVE model is not among the evaluated production models, the run fails visibly.
- The only automatic activation is bootstrap: when no active model exists, the first successful
  run activates the model selected by the existing honest backtest. This is recorded as
  `BOOTSTRAP`, with no user. After that, a non-active model becomes ELIGIBLE only when its
  validation WAPE is at least **0.005 lower** (0.5 percentage points) than ACTIVE on the same run;
  otherwise it is REJECTED. This reuses step 1d's pre-registered material-improvement threshold.
- `POST /ml/models/:id/activate`: admin / inventory manager, ELIGIBLE only, non-empty reason. The
  previous ACTIVE model becomes RETIRED and one immutable activation-history row records who,
  when, from, to and why. Five simultaneous requests produce one activation.
- `POST /ml/models/:id/rollback`: same roles and reason; the target must be the immediately previous
  ACTIVE model from the latest activation/rollback. The current model becomes RETIRED, the target
  becomes ACTIVE, and the history records `ROLLBACK`. It changes policy for the **next** run; it
  never rewrites an existing forecast or recommendation.
- Read roles can see the registry, latest validation/test metrics and activation history. The web
  page labels synthetic metrics and states that activation affects future runs only.
- Schema includes nullable artifact path / SHA-256 and feature/training metadata now so later
  artifact persistence needs no lifecycle redesign. This step does not claim an artifact exists.
- Checks: state/unique constraints; bootstrap, gate and ACTIVE-serving Python tests; API auth,
  validation, concurrency and rollback integration tests; activating/rolling back writes no stock,
  ledger, transfer, order, recommendation or outbox row.

### Step 3a — model registry and manager activation ✅ (2026-11-18)

- Migrations `0017_model_registry.sql` and `0018_model_registry_backfill.sql` add the constrained
  lifecycle states, exactly-one-active enforcement, artifact/training/feature metadata, and an
  immutable append-only activation history. Existing successful runs bootstrap one active model;
  older pre-registry rows are labelled honestly instead of appearing eligible without evidence.
- Forecasting now evaluates all production candidates but serves the registered ACTIVE algorithm.
  A missing/unknown ACTIVE model fails the run visibly. Candidate eligibility uses the documented
  validation-WAPE improvement gate, and the category-average fallback cannot become globally active.
- The API exposes registry/history reads and manager/admin activation and rollback. Decisions require
  a reason, transaction-level serialization makes five simultaneous activations produce exactly one,
  and rollback is restricted to the immediately previous active model. Tests also prove these policy
  changes do not write inventory, transfers, purchase orders, recommendations, outbox or ledger data.
- The Models page shows lifecycle state, synthetic validation/test metrics, training metadata and
  decision history. It explicitly says activation affects future runs and that artifacts are not yet
  persisted, so the UI does not overstate step 3a.
- Verification: API unit **194**, forecasting **98**, API integration **236**, browser e2e **2**;
  formatting, lint, typecheck, production builds and fresh-database migrations are green. API, web and
  forecasting Docker images build successfully. The only Python warning is the existing Starlette
  TestClient deprecation warning.
- Remaining for the next slice: persist and checksum the trained artifact, load that exact artifact
  for serving/rollback, and mirror runs to optional MLflow without making it a runtime dependency.

### Step 3b — artifact persistence and optional MLflow rules (written 2026-11-18, BEFORE building)

- Every activatable registry version gets one immutable, service-owned joblib artifact. The stored
  bundle includes a schema version, model identity, pipeline version, feature order, maximum horizon,
  parameters and (for ML) the fitted estimator. Baseline bundles contain their exact named policy and
  parameters; the category-average per-series fallback remains non-activatable.
- The database stores a path relative to `MODEL_ARTIFACT_DIR`, SHA-256, schema version and creation
  time as one all-or-nothing set. Once present, those fields cannot be changed or cleared. Artifact
  filenames include their content digest, so a database rollback can leave at most an unreferenced
  file and can never cause later bytes to overwrite a registry artifact.
- Before any deserialization, forecasting resolves the relative path under its configured artifact
  root, rejects traversal/symlinks/non-files, hashes the bytes and compares the digest. It then checks
  bundle schema, model id/name/version, pipeline version, features and requested horizon. A missing,
  corrupt or incompatible ACTIVE artifact fails the forecast visibly; it never falls back or retrains
  silently.
- Legacy rows from step 3a have no artifact. Their first successful 3b run is the one explicit
  migration bridge: it trains, writes, hashes, reload-verifies and attaches artifacts once. From the
  following run onward, the ACTIVE artifact is loaded and used for live points and explanations.
  Candidate artifacts are also attached once so a later activation or rollback already has bytes.
- Activation and rollback require artifact metadata. The database activation remains the policy
  switch; the next forecast loads the target row's verified artifact, so rollback restores the exact
  prior bytes without rewriting historical forecasts.
- MLflow is a mirror, never the source of truth. When `MLFLOW_TRACKING_URI` is absent the run records
  `DISABLED`. When present, the service mirrors run parameters, evaluation metrics and the served
  artifact after the PostgreSQL transaction commits. Success records the MLflow run id; any client,
  server or upload error records `FAILED` while the forecast remains `SUCCEEDED` and usable.
- Compose adds a localhost-only optional `mlops` profile with MLflow, SQLite metadata and local
  artifacts. PostgreSQL plus the service-owned artifact volume remain authoritative; deleting or
  stopping MLflow cannot prevent forecasts, activation or rollback.
- Checks: artifact round-trip and deterministic digest; traversal, tamper and metadata mismatch
  rejection before load; second forecast proves the ACTIVE estimator is loaded rather than retrained;
  rollback loads the previous digest; activation without an artifact is denied; MLflow disabled,
  success and unavailable paths; forecasting still writes only the `forecast` schema.

### Step 3b — artifact persistence and optional MLflow ✅ (2026-11-18)

- Migration `0019_model_artifacts_mlflow.sql` completes the all-or-nothing artifact metadata,
  prevents registered bytes from being changed or cleared, and records `DISABLED`, `PENDING`,
  `MIRRORED` or `FAILED` independently of the forecast run status.
- `artifacts.py` writes content-addressed joblib bundles atomically under the configured private root.
  Loading rejects absolute/traversal/symlink paths, non-files, digest tampering, schema/identity/
  pipeline/feature mismatches and unsupported horizons before an estimator is used. Activatable
  baselines have policy bundles; the ML bundle contains the fitted estimator; fallback stays a policy.
- The step-3a legacy bridge materializes the three current production registry rows once. Later runs load the
  ACTIVE bundle for live points and explanations while still training evaluation candidates. Neither
  a later run nor activation can overwrite an artifact. Activation and rollback now require artifact
  metadata; rollback returns to the previous row and therefore its previous digest.
- `mlflow_mirror.py` mirrors committed run/model parameters, every validation/test metric and the
  verified served artifact. It is disabled without a URI and catches server/client/upload failures;
  the PostgreSQL forecast remains `SUCCEEDED`. The optional `mlops` profile runs MLflow 3.18 with
  SQLite/local artifacts on localhost, and its allowed-host policy accepts only the local UI and the
  Compose `mlflow` service name.
- Compose owns model bytes in a dedicated volume initialized for the non-root forecasting user.
  The volume was verified writable as UID 10001; a forecasting-image client successfully queried the
  live MLflow server over the Compose network. API, web and forecasting images all rebuilt.
- Verification: API unit **194**, forecasting **104**, API integration **236**, browser e2e **2**;
  formatting, lint, typecheck, production builds, fresh migrations, artifact tamper checks, MLflow
  success and MLflow-unavailable cases are green. The existing Starlette TestClient deprecation and
  Jest/Node experimental-module warnings remain non-failing.
- The current synthetic dev database was bridged with successful 14-day run
  `53a570db-c098-47ae-9bf1-f87094e53337`: ACTIVE `hgb_direct` v2 and both production baselines now
  have schema-1 digests; MLflow correctly recorded `DISABLED` because no tracking URI was supplied.
- Remaining for 3c: feature/prediction drift, realized WAPE/bias, stale/failed-run alerts and the
  Model Monitoring page. There is still no automatic retraining.

### Step 3c — split (decided 2026-11-18)

- **3c-1** monitoring in the forecasting service: data drift, prediction drift and accuracy on newly
  observed days, stored per monitoring run, triggered after every forecast run and on demand.
- **3c-2** API (`GET /ml/monitoring`, `POST /ml/monitoring/run`), stale-forecast and failed-run
  checks (computed live, since they are about runs that did *not* happen), Model Monitoring page.

### Step 3c-1 — monitoring rules (written 2026-11-18, BEFORE building or measuring)

Monitoring describes; it **never** retrains, activates, rolls back or changes a forecast (tested:
registry unchanged, writes only its own `forecast.*` tables).

**Windows.** Reference = the last **28** days of data up to the ACTIVE model's `training_end` (what
it learned from most recently). Current = the complete days **after** `training_end`, at most the
latest 28. Fewer than **7** current days → every drift check is `INSUFFICIENT_DATA` (never "stable").

**Statistics** (own code with SciPy, decision D2). For each check, two samples (reference, current):
- **PSI** with 10 bins at the reference sample's deciles (duplicate edges merged — sales are
  counts with many zeros), proportions floored at 1e-4: PSI = Σ (c − r) · ln(c / r).
- **KS** two-sample statistic D and p-value (`scipy.stats.ks_2samp`), reported for context only:
  with ~28,000 points almost any difference is "significant", so p does not set the status.
- Status from PSI (common convention): **STABLE** < 0.10, **WATCH** 0.10–0.25, **DRIFT** ≥ 0.25.

**Checks.**
1. *Feature drift* — the model's demand inputs at every origin in each window (horizon 1, all
   series with enough history): `mean_7d`, `mean_28d`, `mean_56d`, `std_28d`, `last_same_weekday`,
   `ratio_7d_28d`. Calendar inputs (weekday, season, horizon) change by design and are not checked.
2. *Sales level per store* — daily units per product at each store, reference vs current.
3. *Prediction drift* — the ACTIVE model's day-1 forecast at every origin of each window, made with
   its loaded, verified artifact (ML) or its baseline rule.
4. *Accuracy on newly observed days* — every kept run's forecast points (days 1–7, model-served
   series; fallback series excluded) whose day now has data (no row = 0 units, as in training):
   realized WAPE and bias, compared with the ACTIVE model's backtest **test** WAPE.
   **INSUFFICIENT_DATA** below 7 distinct days or 1,000 points; **DEGRADED** if realized WAPE
   exceeds backtest test WAPE by more than **5 points** or |bias| > **10 %**; else **OK**.
   Five points is far above the seed-to-seed noise (~0.15, step 1d) but a 7-day window is noisier
   than a 28-day test window; the threshold is a starting point, stated as such.

**Storage** (migration 0020): `forecast.monitoring_runs` (trigger, forecast run, model version,
windows, overall status per check family) and `forecast.monitoring_results` (one row per check
subject with PSI, KS D/p, sample sizes, WAPE, bias, points, status). Immutable; the newest 30
monitoring runs are kept.

**Checks of the code:** PSI hand-checked on small samples and 0 for identical samples; synthetic
data with a known +50 % demand shift after training must give DRIFT on demand features and that
store's sales, STABLE on an unshifted store and on an unshifted control; an unshifted series must
not degrade; accuracy hand-checked on a tiny table; under 7 days → INSUFFICIENT_DATA; registry and
non-forecast tables unchanged. Measured on the dev data and reported as found (expected:
INSUFFICIENT_DATA, because the ACTIVE model was trained through the latest data day).

### Step 3c-1 — model monitoring ✅ (2026-11-18)

- Migration `0020_model_monitoring.sql`: `forecast.monitoring_runs` and `forecast.monitoring_results`
  (immutable by trigger; no FK to forecast runs because those are pruned). Package
  `app/monitoring/`: `drift.py` (PSI, KS, status), `monitor.py` (windows and the four checks, pure),
  `store.py` (SQL), `run.py` (one run; failures stored as FAILED). Runs after every forecast run and
  via `POST /monitoring/run` on the forecasting service. Nothing retrains or activates (tested).
- **Pre-registered expectation only partly met.** A +50 % demand shift after training:
  per-store sales PSI ≈ 1.8 (**DRIFT**) for shifted stores, 0.004–0.011 (**STABLE**) for unshifted
  ones; the unshifted control is STABLE everywhere. But the pooled demand inputs did **not** all
  reach DRIFT: network-wide shift → `mean_7d` 0.26, `std_28d` 0.30, `last_same_weekday` 0.34,
  `ratio_7d_28d` 0.38 (DRIFT), `mean_28d` 0.15 (WATCH), `mean_56d` 0.05 (STABLE) — longer windows
  still average pre-shift days; a one-store shift barely moves pooled inputs (≤ 0.11). The overall
  data-drift status still flags every shifted case because the per-store check catches it.
  Thresholds were not changed after seeing this; the tests assert the measured behaviour.
- Prediction drift with a 28-day moving average as ACTIVE model: network-wide +50 % → PSI 0.15
  (WATCH) — the forecast itself lags the shift.
- Dev data (as expected): ACTIVE `hgb_direct` v2 was trained through 2026-11-17, the latest data
  day, so 0 new days → all three statuses `INSUFFICIENT_DATA`. For context only: kept forecasts
  for 2026-11-17 (1 day, 2,850 points, simulator sales) show realized WAPE 116 % vs backtest 54 %,
  bias −12.7 % — one unusual day, below the 7-day minimum. Cost: 7.2 s and 355 MB per run.
- The Docker `forecasting` container still runs pre-3b code (no artifact volume); it was not
  recreated, because its empty artifact volume would make forecasts fail until artifacts are
  bridged there — to be handled with 3c-2.
- Tests: Python 104 → 124 (PSI by hand, thresholds, windows, known shifts, accuracy by hand,
  stored after a run, registry and non-forecast tables unchanged, immutable rows, failure isolated,
  pruning); API unit 194 and integration 236 unchanged and green (fresh migrations include 0020).


### Step 3c-2 — monitoring API, run health and page: rules (written 2026-11-18, BEFORE building)

**API** (module `ml`, which now also calls the forecasting service through `forecasts`'
`ForecastClient`):
- `GET /ml/monitoring` (read roles): the latest monitoring run with every result, the 10 most
  recent runs (summary), the run-health checks below and the thresholds in words. Writes nothing.
- `POST /ml/monitoring/run` (admin / inventory manager): asks the service to monitor now
  (synchronous, 60 s timeout). Service down → 503, service error → 502, as for forecast runs.

**Run health** — computed on request, never stored (it is about runs that did *not* happen), and it
never starts, retries or changes anything. Each check is OK / WARN / ALERT with one sentence:
1. *Forecast freshness*: days behind = (today − 1) − the latest successful run's last data day.
   0 → OK; 1 → WARN; ≥ 2, or no successful run at all → ALERT.
2. *Latest forecast run*: FAILED → ALERT (with its error); RUNNING → OK ("in progress");
   SUCCEEDED → OK. A failure followed by a later success is shown in history only.
3. *Monitoring itself*: no monitoring run yet → WARN; the latest one FAILED → ALERT; the latest
   monitoring run older than the latest successful forecast run → WARN (monitoring missed a run).
4. *Model quality* from the latest successful monitoring run: data or prediction DRIFT, or
   accuracy DEGRADED → ALERT; WATCH → WARN; OK / STABLE → OK; INSUFFICIENT_DATA → OK with the
   sentence "not enough new days to judge yet" (never presented as healthy evidence).
Overall = the worst check.

**Page** `#/monitoring` (linked from the Models page; no new top-level nav item, the bar is
already crowded): run-health list, the latest windows in words, the three statuses, tables for
inputs, sales per store, forecasts and accuracy (PSI, KS D, sample sizes, WAPE vs backtest),
recent runs, the thresholds, and "Run monitoring now" for approvers. Synthetic-data label; every
INSUFFICIENT_DATA says why. Fits a phone screen.

**Docker demo**: the `forecasting` container is recreated with 3b/3c code; the existing verified
artifacts are copied into its artifact volume (same relative paths and digests — nothing is
retrained or re-registered), so the demo can forecast and monitor.

**Checks:** each run-health rule hand-tested through the API with crafted run/monitoring rows
(including no runs at all); roles (analyst/store manager can read but not run); service down →
503; `GET` writes nothing; e2e or browser check of the page at desktop and phone width.

### Step 3c-2 — monitoring API, run health and page ✅ (2026-11-18)

- `ml` module: `GET /ml/monitoring` and `POST /ml/monitoring/run` (through `ForecastClient`, now
  exported by `forecasts`; module map `ml → forecasts`). Run health is a pure function
  (`monitoring.health.ts`) over the latest rows, with dates from the database clock.
- Page `#/monitoring` (linked from Models; the Models nav item stays highlighted): run health,
  windows in words, the three statuses, inputs / stores / forecasts tables with PSI and KS D,
  accuracy vs backtest, recent runs, thresholds in words; the run button for approvers only.
  Desktop and phone: 0 px overflow.
- One test-fixture bug found while building: fixture monitoring rows were stamped "now" while
  forecast runs were back-dated, so an old monitoring run looked newer than a stale forecast. Fixed
  in the fixture (rows now follow their run); the rule itself was right.
- **Docker demo:** images rebuilt; the three existing artifacts were copied into the
  `model_artifacts` volume and their SHA-256 digests compared equal to the registry; `forecasting`,
  `api`, `web` recreated (`--no-deps`, so synthetic history was not regenerated). Through the demo
  (port 8080) *Run monitoring now* took 3.9 s, loaded the verified `hgb_direct` v2 artifact and
  stored 13 results; health OK; quality "not enough new days (0 since training; 7 needed)".
- Tests: API unit 194 → 212 (every health rule), integration 236 → 243 (crafted runs: no runs,
  fresh, failed, stale, missed monitoring, drift; read roles; approvers only; GET writes nothing;
  service OK / 502 / 503); Python 124 unchanged; e2e 2. All green.


### Step 4a — split (decided 2026-11-18)

- **4a-1** Control Tower data: `GET /overview` extended (KPIs, risk panel, chart series) and
  `GET /overview/locations` (per-location health), store-scoped, with a measured p95.
- **4a-2** the Control Tower page (KPI row, risk panel with links, location table, 4 plain-SVG
  charts) and the navigation regrouped into a few menus.

### Step 4a-1 — Control Tower data: rules (written 2026-11-18, BEFORE building or measuring)

Same read-model rules as the Overview (decision #42): reads across modules, writes nothing, the
store scope of the caller applies everywhere (store managers: their stores only; DCs only for
roles that may read every location). Existing definitions are reused, not redefined: at risk /
excess (Overview, 7 and 60 days), open anomaly = NEW or INVESTIGATING (1e-2), supplier score (2c).
Value "at cost" = units × the product's primary supplier unit cost.

**KPIs** (added to today's): units on hand and available; stock value at cost; open transfers
(REQUESTED, APPROVED, DISPATCHED) touching the scope; open anomalies; excess value at cost.

**Risk panel**, each a count with the link target the page will use:
- at risk within **7** days (as today) and within **14** days (same rule, 14-day forecast window);
- excess positions, units and value at cost;
- **delayed transfers**: APPROVED and not dispatched, or DISPATCHED and not received, for more than
  **2 days** (the transfer lead time used by replenishment) since approval / dispatch;
- **overdue purchase orders**: APPROVED with `expected_date` before today;
- open anomalies (and how many are HIGH);
- **supplier risk**: suppliers with a reliability score below **75** (2c scores: 86 / 81 / 69), with
  their open purchase orders in scope.

**Charts (data series only in this step):** stock health per store (out / at risk / healthy /
excess counts); network daily units sold for the last 28 days of forecast history plus the latest
forecast's next 14 days; excess value at cost per store; supplier on-time rate and score.

**`GET /overview/locations`**: one row per location in scope — code, name, type; units on hand,
available, value at cost; out-of-stock, at-risk (7 d) and excess counts (stores only; DCs show
none because they have no forecast); pending recommendations; open alerts; open anomalies;
inbound and outbound open transfers.

**Performance target, fixed now:** on the dev data (200 products × 7 locations), **p95 ≤ 300 ms**
for each endpoint as admin, measured over 200 sequential requests against a running API.

**Checks:** integration tests with hand-built stock for every KPI and risk count (including the
2-day delay boundary and the overdue-PO boundary), store-manager scope (no other store, no DC),
GET writes nothing; unit tests for any new pure function.

### Step 4a-1 — Control Tower data ✅ (2026-11-18)

- `GET /overview` gains `controlTower` (rules, KPIs, risk panel, chart series); new
  `GET /overview/locations`. Pure `classifyPosition`, `healthByStore`, `atRiskWithin`; the module now
  also reads supplier scores through `SuppliersService` (`overview → suppliers`). Every definition is
  reused from the Overview, 1e-2 and 2c; nothing is written.
- **p95 target met** (≤ 300 ms, 200 sequential requests as admin after 10 warm-up, local build on the
  dev data: 200 products × 7 locations, 1,400 balances): `/overview` p50 109.9 / **p95 122.5** /
  max 145.6 ms; `/overview/locations` p50 25.8 / **p95 29.5** / max 34.5 ms.
- Dev data: 167,280 units on hand, 526,146.65 at cost; at risk 239 (7 d) / 443 (14 d); excess 49
  positions, 714 units, 2,887.14 at cost; 410 open anomalies (29 HIGH); 2 open transfers, none
  delayed; no purchase orders; supplier risk: Summit Household (score 68.9). The old Overview numbers
  are identical (at risk 239, excess 49 / 714, out of stock 129 = 27 + 29 + 26 + 27 + 20 per store).
- Tests: API unit 212 → 215, integration 243 → 251 (KPI deltas from a hand adjustment, 7 vs 14-day
  risk, excess value, the 2-day transfer-delay boundary ±5 minutes, the overdue-PO boundary (due today
  vs yesterday), supplier risk with open orders, anomalies and HIGH, locations table incl. DCs, store
  scope, writes nothing). Two mistakes in my own tests fixed (a helper with the wrong daily rate,
  a loose type); no code change was needed. Python 124 and e2e unchanged; Docker API rebuilt.


### Step 4a-2 — Control Tower page and navigation: rules (written 2026-11-18, BEFORE building)

**Page** — the Overview becomes the **Control Tower** (same route `#/`, same store scope); nothing
already on it is removed (stock-out / at-risk / excess tiles and top lists, freshness):
1. KPI row: units on hand, value at cost, open transfers, open anomalies, excess value at cost,
   pending recommendations — each a stat tile with a plain label; one hero-free row.
2. **Risk panel**: at risk 7 d / 14 d, excess, delayed transfers, overdue purchase orders, open
   anomalies (HIGH), suppliers at risk — each a count, a one-line meaning and a link to the page
   that lists it (Stock, Transfers, Purchase orders, Unusual activity, Suppliers, Replenishment).
   A zero is shown as zero, never hidden.
3. **Location table** from `GET /overview/locations` (stores first, DCs show "—" where no forecast).
4. **Four charts**, plain SVG like the existing forecast chart, following the dataviz skill:
   - *Stock health by store* — one tall segmented bar per store (out of stock / at risk / healthy /
     excess / no forecast), state colours from the status palette (critical / warning / good),
     excess in the sequential blue, no forecast in neutral grey; legend always shown; counts inside
     a segment only when they fit.
   - *Units sold and forecast* — one line chart, two series (last 28 days sold, next 14 days
     forecast; categorical slots 1 and 2), one y-axis, legend, crosshair tooltip with both values.
   - *Excess value at cost by store* — horizontal bars, single series, value at each bar's tip.
   - *Supplier on-time rate* — horizontal bars, value at the tip; suppliers below the score
     threshold say so in text next to the bar (not by colour alone).
   Every chart: hover and keyboard focus show the exact value; each has a "Show as table" view, so
   no value is tooltip-only; ≤ 24 px bars, 2 px lines, hairline grid, text never in series colours.
   Light theme only, as the rest of the app (no dark mode exists yet — stated, not hidden).
   Palette validated with the skill's `validate_palette.js` before use.

**Navigation** — the 12 flat links become 5 entries: **Control Tower**, **Inventory** (Products,
Stock, Transfers, Purchase orders, Alerts), **Planning** (Replenishment, ABC/XYZ, Suppliers),
**Intelligence** (Unusual activity, Models), **Health**. Groups are disclosure menus (button with
`aria-expanded`, Escape and outside-click close, keyboard reachable); the group of the current page
is highlighted; one row on desktop; fits a phone without horizontal scroll.

**Checks:** typecheck/lint/build; the e2e test updated for the new name and still green (it is the
navigation test too); screenshots at 1280 px and 390 px with 0 px horizontal overflow; every chart
checked by eye for clipped labels; keyboard: Tab reaches every menu item and chart mark.

### Step 4a-2 — Control Tower page and navigation ✅ (2026-11-18)

- The landing page is now the **Control Tower** (same route and scope; everything on the old
  Overview kept): KPI row, a **Risks** list (each count with its meaning and a link; zeros shown),
  four charts, the locations table. Components: `ControlTower.tsx`, `charts/` (`ChartCard` with
  legend and "Show as table", `SegmentedBars`, `HBarChart`, `SalesLineChart`, `useTooltip`,
  `theme.ts`). The KPI row shows *units available* instead of *pending recommendations*, which the
  first row of tiles already shows.
- **Palette validated by script** (`validate_palette.js`, light surface): line series blue/orange
  pass every check; stock-state segments pass the hard gates with two allowed warnings (yellow vs
  green CVD 6.3, yellow contrast 2.1:1), covered by 2 px gaps, in-segment counts, legend and table
  view. The status palette's own warning yellow failed the lightness band, so the categorical
  yellow step is used for "at risk" (recorded in `theme.ts`).
- **Navigation:** 12 flat links (not 13 as first written) → Control Tower, Inventory ▾, Planning ▾,
  Intelligence ▾, Health. Menus close on Escape (focus returns to the button), outside click and
  page change; the open direction is chosen from the button's position.
- **Found by looking, fixed before reporting:** supplier names were clipped ("Greenfield Fr…"); the
  line chart's text rendered at ~7 px (720-unit view box drawn at ~470 px); the Planning menu ran
  off a phone screen (my first overflow check only opened the Intelligence menu, which opened
  leftwards); two lint errors from the React compiler rules (state set inside an effect; a ref read
  during render) fixed by deriving menu state and fixed-positioning the tooltip; a duplicate
  "No forecast yet" message (the empty chart now says "Appears after the first forecast run").
- **Checks:** every menu inside the window at 1280 / 768 / 390 / 320 px; page overflow 0 px at 1280
  and 390; keyboard: Escape → focus on the menu button, Enter / Tab / Enter navigates, a focused chart
  mark shows its value; e2e updated to open menus and still green (2). API unit 215, integration
  251, Python 124 unchanged. Light theme only (the app has no dark mode). Docker web rebuilt.


### Step 4b — split (decided 2026-11-18)

- **4b-1** scenarios data and API: stored scenario parameters, a run that recomputes the
  replenishment batch in memory for a baseline and the scenario, a stored summary, proof that
  nothing else is written.
- **4b-2** the Scenarios page: create, run, and compare 2–3 scenarios side by side.

### Step 4b-1 — what-if scenarios: rules (written 2026-11-18, BEFORE building or measuring)

**One calculation.** Replenishment generation is split into *load inputs → compute the batch in
memory → write*. A scenario run is *load inputs → adjust them → compute the batch twice (baseline
with the unadjusted inputs, scenario with the adjusted ones) → store one summary row*. The same pure
functions decide every quantity (safety stock, sources, excess, review flags, stockout dates);
there is no second implementation. Both computations use the same loaded snapshot, so their
difference is caused by the parameters only.

**Parameters** (stored, never edited — a different idea is a new scenario):
- `demandPct` −50 … +200: every forecast value × (1 + p/100); the forecast error σe is scaled by the
  same factor (errors grow with the level, measured in step 1b).
- `supplierLeadTimeDays` 0 … 30: added to every supplier's promised lead time (measured delays still
  apply on top); transfer lead time unchanged.
- `dcAvailabilityPct` 0 … 100: DC stock usable for transfers reduced by this share (rounded down).

**Summary stored per run** (baseline and scenario, same shape): recommendations by action and risk,
flagged for review, units per action, purchase-order value at cost, needs covered from store excess,
positions out of stock now / running out within 7 and 14 days (expected stockout date with the
adjusted forecast), and how long the run took.

**Tables** (migration 0021): `scenarios` (name, description, the three parameters, who / when) and
`scenario_results` (scenario, forecast run used, who / when, baseline and scenario summaries as JSON,
duration). Both immutable.

**API:** `POST /scenarios` and `POST /scenarios/:id/run` for admins / inventory managers;
`GET /scenarios` (with each latest result) and `GET /scenarios/:id` (all results) for admins,
inventory managers and analysts. **Store managers: 403** — results are network-wide and would show
other stores' needs.

**Checks:**
1. A test proves running scenarios writes nothing outside `scenario_results`: inventory ledger and
   balances, outbox, transfers, purchase orders, recommendations, alerts unchanged (row counts and
   a checksum of balances).
2. A zero scenario (0 / 0 / 0) gives a summary identical to its baseline; running the same scenario
   twice on unchanged data gives identical summaries.
3. Directional sanity on the dev data, fixed now: +20 % demand → at least as many recommendations and
   units as baseline; +5 supplier days → purchase-order units at least baseline; DC −100 % → zero
   transfers from DCs and at least as many purchase orders. Exact numbers reported as found.
4. Hand-checked unit tests for the input adjustments.

### Step 4b-1 — what-if scenarios ✅ (2026-11-18)

- Replenishment generation refactored to *load → `computeBatch` (pure) → write*; the existing 81
  unit and 40 integration replenishment tests passed unchanged after the refactor. New pure
  `applyScenario` / `summarizeBatch` (`replenishment.scenario.ts`), module `scenarios`
  (`scenarios → replenishment`), migration `0021_scenarios.sql` (immutable tables).
- **Pre-registered checks:** (1) writes nothing — integration test (row counts + an MD5 over every
  balance) and on the dev data: ledger, all balances, recommendations, transfers, purchase orders and
  outbox byte-identical after five scenario runs; (2) a zero scenario equals its baseline and two runs
  are identical — passed; (3) directions on the dev data — +20 % demand more recommendations and units
  (passed), DC −100 % zero DC transfers and more purchase orders (passed), +5 supplier days purchase
  orders ≥ baseline — **passed only trivially (0 ≥ 0)**: on this data DCs cover every need, so no
  purchase order exists for a longer lead time to affect (the integration fixture, which has an order,
  shows the effect).
- Measured on the dev data (1,000 positions; baseline = 294 recommendations: 269 transfers, 25 excess
  moves — identical to the last real generation; 239 run out within 7 days — identical to the Control
  Tower):

  | Scenario | Recs | Transfers (units) | Purchase orders (units, at cost) | Excess moves | Critical | Out ≤ 7 d / ≤ 14 d | ms |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | No change | 294 | 269 (10,494) | 0 | 25 | 194 | 239 / 443 | 348 (cold) |
  | Demand +20 % | 302 | 294 (13,435) | 0 | 8 | 212 | 288 / 517 | 80 |
  | Suppliers +5 days | 294 | 269 (10,494) | 0 | 25 | 194 | 239 / 443 | 86 |
  | DC stock unavailable | 421 | 5 (66, from store excess) | 391 (26,204; 81,346.88) | 25 | 286 | 239 / 443 | 116 |
  | Holiday rush (+30 %, +3 d, DC −50 %) | 314 | 292 (13,295) | 17 (3,223; 8,325.41) | 5 | 226 | 307 / 538 | 82 |

  "DC stock unavailable" raises recommendations by 127: the supplier lead time is longer than a
  transfer's, so more positions fall below their reorder point.
- Tests: API unit 215 → 218, integration 251 → 258 (no forecast → 409; zero = baseline; identical
  reruns; writes nothing; directions; list / detail; roles incl. store managers 403; validation;
  immutability). Python 124 and e2e unchanged. Docker API rebuilt.


### Step 4b-2 — Scenarios page: rules (written 2026-11-18, BEFORE building)

**Page** `#/scenarios`, under **Planning** in the menu; visible to admins, inventory managers and
analysts (store managers do not see the menu item; the API refuses them anyway).
- **Create** (admins / inventory managers): name, optional description, and the three parameters
  with their limits shown; the server's validation message is shown on error.
- **List:** every scenario with its parameters in words, who created it, and its latest result's
  headline (recommendations, purchase-order value, positions running out within 7 days) with the
  change against its own baseline; "Run" for approvers; "never run" when there is no result.
- **Compare 2–3:** select up to three scenarios → a comparison **table** (a table, not a chart:
  twelve metrics across a few columns is a lookup task) — rows are the summary metrics, columns the
  baseline and each scenario, each scenario cell showing its value and the signed change.
  If the selected results were not computed from the same forecast run *and* identical baselines,
  the page says so and shows each scenario's change against its *own* baseline; "Run selected now"
  (approvers) re-runs them one after another to bring them close in time.
- What a scenario cannot show is stated on the page: totals only (not per product), stock as it was
  when the scenario ran, and a parameter that the batch does not use shows no effect.

**Checks:** e2e: create a scenario and run it on the test database (which has no forecast) and see
the clear "no forecast yet" message; browser check against the demo data: create, run, compare three
scenarios; no horizontal overflow at 1280 / 768 / 390 / 320 px; keyboard can select and compare.

### Step 4b-2 — Scenarios page ✅ (2026-11-18)

- `#/scenarios` under **Planning** (hidden from store managers, who also get "not allowed" from
  the API): create form with the limits shown, scenario list with parameters in words and each
  latest result's change against its own baseline, *Run* for approvers, and a **comparison table**
  for up to three (one baseline column when all results share the forecast run and baseline,
  otherwise a warning and changes against each scenario's own baseline; *Run selected now*).
  The page states what a scenario cannot show.
- e2e: a third test creates a scenario through the menu and checks the "There is no forecast yet"
  message (the e2e database has no forecast). My first version built a regular expression from a
  name containing "+" — fixed in the test.
- **Found while checking widths:** the page scrolled sideways on phones (167 px at 390, 237 px at
  320). Cause: `sr-only` table-header labels are absolutely positioned and escaped the table's scroll
  box. One-word fix in the shared table style (`relative` on `table.wrap`); this also fixed the
  product page's old phone overflow (547 px → 0).
- **Then, at the user's request, every remaining phone overflow was fixed** (found per page by
  locating the innermost element past the edge, or by hiding elements one at a time):
  location drop-downs sized to their longest option (shared `field` now `max-w-full`, their labels
  may shrink); search rows that could not wrap their button (Products, Stock); a non-wrapping
  filter row (ABC/XYZ); a sentence link using the no-wrap table-link style (Models → new
  `table.textLink`); the freshness list's two columns (one column below `sm`); and the supplier
  bar chart, whose rows added value and note after a percentage-wide bar (each bar now has its own
  track, the value follows it in an aligned column, the note sits below — bars stay proportional at
  any width). **Result: 0 px horizontal overflow on all 15 pages at 1280, 768, 390 and 320 px**
  (60 measurements); the changed spots were looked at in screenshots.
- Browser check on the demo data: three scenarios compared by keyboard (Space on the check boxes);
  numbers identical to step 4b-1's measurements; 0 px overflow at 1280 / 768 / 390 / 320.
- Tests: API unit 218 and integration 258 unchanged; e2e 2 → 3; Python 124. Docker web rebuilt.


### Step 4c — split (decided 2026-11-18)

- **4c-1** reports data and API: generated snapshots (`report_runs`), CSV export, the daily/weekly
  schedule, store scope.
- **4c-2** the Reports page: list, view, print-friendly layout (browser "Save as PDF", decision D7).

### Step 4c-1 — reports: rules (written 2026-11-18, BEFORE building or measuring)

**A report is a frozen snapshot** of one period and one scope, stored as JSON in `report_runs`
(immutable) and never recomputed: reading it later shows exactly what was generated, with its
period and generation time.
- **Kind:** DAILY (one day) or WEEKLY (seven days ending on the period end). Days are UTC calendar
  days, as in the forecast's ledger roll-up. Default period end: yesterday.
- **Scope:** the whole network, or one location.

**Contents** (all from data the system records; synthetic labelled):
1. *Sales in the period* (ledger SALE and RETURN rows): units sold, units returned, sales value at
   the product's current unit price (stated: not the price at the time of sale), sales per store,
   top 10 products by units.
2. *Stock movements in the period*: units per movement type (receipts, transfers in / out,
   adjustments as net and as removed, returns).
3. *Work done in the period*: transfers requested / dispatched / received, purchase orders created /
   received, recommendations generated / approved / rejected, alerts opened, anomalies found and
   reviewed.
4. *Stock at generation time* (stated as such — not at period end, which the system cannot
   reconstruct cheaply): the Control Tower figures for the same scope (units, value at cost, out of
   stock, at risk 7 / 14 days, excess) — reused from the Overview read model, not recomputed.

**Access:** store managers generate and read reports for their own stores only (network-wide and
other locations: 403); admins, inventory managers and analysts generate and read any scope.

**CSV:** `GET /reports/:id/export.csv` — one row per number: `section,metric,location,product,value`,
RFC 4180 quoting, header row, UTF-8; a file name with kind, scope and period.

**Schedule** (with the other background jobs, `HOUSEKEEPING_ENABLED`; off in tests): every hour the
API checks for yesterday's network DAILY report and, on Mondays, last week's WEEKLY report, and
creates any that are missing. A unique index on scheduled reports (kind, period, scope) makes two
API instances or a restart unable to create duplicates. Manual reports may repeat (each is its own
snapshot).

**Checks:** hand-built ledger rows → exact totals, including the UTC day boundary (a sale at 23:59:59
vs 00:00:00); weekly = sum of its seven days; store scope (own store yes, other store / network 403);
CSV header, quoting and one row per number; the scheduled job run twice → one report each; generating
writes nothing outside `report_runs`. Measured on the dev data: generation time and snapshot size.

### Step 4c-1 — reports ✅ (2026-11-18)

- Module `reports` (`reports → overview`; `OverviewService.forScope` added so a report reuses the
  Control Tower figures for its scope), migration `0022_reports.sql` (`report_runs`, immutable;
  unique scheduled reports; an index on `inventory_ledger.occurred_at` for the time-range queries).
  Pure `reports.period.ts` (UTC days, weeks, what the schedule owes) and `reports.csv.ts`.
- **Checks:** exact totals from hand-built ledger rows including the UTC boundary (a sale at
  00:00:00 and at 23:59:59.999 count; the instants before and after do not); weekly = its seven days;
  network = sum of stores; frozen (a later sale changes a new report, never an old one; UPDATE refused);
  periods must be complete (422); store scope (own store yes; other store, network report and list
  filter 403); CSV header, quoting, rows and file name; the schedule run twice — and twice
  concurrently — creates one report per due period; generating writes nothing else (counts + balance
  checksum).
- One mistake in my own test (a CSV expectation that ignored a sale added by the previous test);
  the code was right.
- Measured on the dev data (yesterday = 2026-11-17): network DAILY 2,845 units sold — identical to the
  Control Tower's "latest day sold" — 15,173.43 at current prices; STR-01 647 units; stock figures equal
  the Control Tower's. Receipts of 170,151 units on that day are the seed loading the initial stock (a
  reader of this demo should know). The WEEKLY report equals the DAILY because the ledger has no sales
  before 2026-11-17 (older history is synthetic forecast data, not ledger rows). 170–450 ms per report,
  about 2.9 KB, 47–55 CSV rows. Ledger, balances, recommendations, transfers, orders and outbox
  identical afterwards.
- **Schedule seen working in the Docker demo:** 3 minutes after the rebuilt API started it created
  the network DAILY report for 2026-11-17 on its own (`SCHEDULED`, 706 ms); no WEEKLY, because
  2026-11-18 is a Wednesday.
- Tests: API unit 218 → 225, integration 258 → 266; Python 124 and e2e 3 unchanged.


### Step 4c-2 — Reports page and print layout: rules (written 2026-11-18, BEFORE building)

**Pages** (every signed-in role; menu **Intelligence → Reports**):
- `#/reports` — generate form (kind, scope: network or one location — store managers only see their
  own stores and no "network" choice — and an optional period end, latest yesterday), and the list of
  reports (kind, period, scope, scheduled or by whom, generated at), newest period first, paginated.
- `#/reports/:id` — the snapshot in words and tables: header with **period, scope and generated-at**
  always visible, sales (totals, per store, top products), movements, work done, stock at generation
  time (labelled as such), and the stated limits (current prices; stock at generation, not period
  end; synthetic data). **Download CSV** (the API export) and **Print** buttons.

**Print** (decision D7: the browser's "Save as PDF", no PDF service): a print stylesheet hides the
navigation, buttons and other screen-only chrome, keeps tables whole where possible, prints in
black on white, and keeps the period, scope and generated-at at the top of page 1.

**Checks:** e2e — generate a network report through the menu, open it, see period and generated-at,
the CSV link points at the export, and in print media the navigation and buttons are hidden; browser
check on the demo data at 1280 / 768 / 390 / 320 px (0 px overflow) plus a print-to-PDF of one report
looked at page by page; store manager sees only own-store scopes.

### Step 4c-2 — Reports page and print layout ✅ (2026-11-18)

- **Intelligence → Reports** (`#/reports`): generate form (kind, scope — store managers see only
  their stores and no network choice — optional last day), list of reports (period, kind, scope,
  scheduled or by whom, generated at). `#/reports/:id`: header with period, scope, generated at and
  by whom; sales, movements, work, stock at generation time (labelled), sales per store, top
  products, the stated limits; *Download CSV* and *Print / save as PDF*.
- **Print:** the app header, back link and buttons are `print:hidden`, the page prints on white,
  sections avoid page breaks inside. A Chromium A4 print of the demo's network report: two pages,
  period / scope / generation line at the top of page 1, every table whole, numbers identical to the
  API (2,845 units; STR-01 647).
- **Checks:** e2e 3 → 4 (generate through the menu, see period and generated-at, the CSV link
  downloads a file with the right header, print media hides navigation and buttons); 0 px overflow
  on both pages at 1280 / 768 / 390 / 320; store manager: only "STR-01" offered, only STR-01 reports
  listed, a network report refused with "Store managers can only use reports for their own stores."
  API unit 225 and integration 266 unchanged (no API change); Docker web rebuilt.

### Step 4d — Grafana business dashboards ✅ (2026-11-18)

- Migrations `0023_business_intelligence.sql` and `0024_supplier_score_zero_lead.sql` add
  owner-executed, security-barrier views in the
  `reporting` schema: `sales_daily`, `inventory_snapshot`, `forecast_quality` and
  `supplier_performance`. The cluster-wide `retailpulse_grafana` role has `SELECT` on those views
  only. It has no application/forecast table privilege and no write privilege; the integration test
  switches to that role and proves both denials.
- The optional observability profile injects `GRAFANA_DB_PASSWORD`, enables the otherwise-`NOLOGIN`
  role, and provisions PostgreSQL beside Prometheus. No database credential is committed. Grafana
  keeps *RetailPulse API* and adds four read-only dashboards with store/category/model/supplier
  filters and explicit synthetic/snapshot/current-price labels.
- Live Grafana 12.1 verification: PostgreSQL and Prometheus health both `OK`; its search API lists all
  five dashboards; Chromium loaded every business dashboard without query, datasource or panel-plugin
  errors. Measured through the restricted role on the current demo: 349,084 daily product/store sales
  rows (1,139,702 units over 2025-11-17–2026-11-17), 1,400 inventory rows (167,280 on hand,
  $526,146.65 at current cost), 30 model-metric rows over five runs, and 2,601 supplier deliveries.
- Tests: API unit **225**, integration **266 → 270**, forecasting **124**, browser e2e **4**;
  formatting, lint, typecheck, both production builds, Compose validation and fresh-database
  migrations all pass. The four new integration tests cover view facts, the zero-day supplier-score
  edge, the database boundary and the provisioned dashboard JSON.

### Step 5a — generated OpenAPI ✅ (2026-11-18)

- `core/openapi/openapi.routes.ts` registers all **73** Nest operations (70 paths) with method,
  internal path, tag, summary, success status/media type and references to the same Zod body/query
  objects used by controllers. `openapi.document.ts` uses Zod 4 input JSON Schema and documents the
  session cookie, idempotency header, path/query parameters, errors, JSON/CSV/text/HTML and the
  root-level `/metrics`; there is no new dependency.
- Signed-in users can download `/api/v1/openapi.json` or use the self-contained `/api/v1/docs`
  reader. Both return 401 when signed out. Login/logout/health/metrics are correctly marked public
  inside the contract. Response field schemas are deliberately absent until those responses have
  runtime Zod validators; status and content type are documented now without inventing a second
  model beside the TypeScript interfaces.
- The coverage test discovers Nest controllers and compares method + path with the registry in both
  directions, and checks duplicate registry entries and operation IDs. Unit tests also check Zod
  defaults/limits, cookie security, public routes, the idempotency header and protected docs.
- Live production-build check on port 3002: signed out **401**, signed-in analyst **200**; OpenAPI
  3.1 with 73 unique operation IDs; Chromium rendered 73 route cards in 22 groups. The browser e2e
  repeats the signed-in reader flow through the normal Vite API proxy.
- Verification: API unit **225 → 229**, integration **270**, forecasting **124**, browser e2e
  **4 → 5**; formatting, lint, typecheck and both production builds pass.

### Step 5b — OpenTelemetry tracing ✅ (2026-11-18)

- The API starts the optional Node SDK before Nest, with HTTP, Express and PostgreSQL
  instrumentation and OTLP/HTTP export. FastAPI has matching optional OTLP export and inbound W3C
  instrumentation. No endpoint means no Node SDK/exporter; neither application depends on Jaeger.
- Active API spans carry `retailpulse.correlation_id` and return `x-trace-id`. Calls to forecasting
  inject `traceparent` and forward `x-correlation-id`; forecasting attaches the same correlation ID
  and returns the shared trace ID. The pre-export processor removes SQL/body attributes and redacts
  every URL query value while retaining parameter names.
- The optional `tracing` Compose profile runs Jaeger 2.23 with in-memory storage, private OTLP/HTTP
  ingestion and its localhost-only UI on port 16686. Both service images were rebuilt with tracing
  enabled. Jaeger's API listed `retailpulse-api` and `retailpulse-forecasting`.
- Live check: one monitoring request returned correlation `live-trace-5b-12345` and trace
  `53c52497fffc39a3733449be0e62b305`; that exact Jaeger trace contained both services, the same
  correlation attribute on both server spans and PostgreSQL spans. A request containing
  `search=supersecret5b` stored only `search=REDACTED`; the raw trace contained no secret, SQL text
  or body attribute. With Jaeger stopped, API health, FastAPI health and a real API → forecasting
  monitoring call all remained **200**; Jaeger was then restarted.
- Verification: API unit **229 → 234**, integration **270**, forecasting **124 → 127**, browser e2e
  **5**; formatting, lint, typecheck, both production builds, Compose validation and Docker images
  all pass.

### Step 5c — security review ✅ (2026-11-18)

- `docs/SECURITY-REVIEW.md` records the threat model, evidence-linked executable checklist, six
  fixed findings, accepted local-demo risks, deployment requirements and repeatable commands. It
  explicitly keeps forecasting and the optional infrastructure inside their current trust boundary
  and does not describe the synthetic localhost demo as production-ready.
- Unsafe browser writes now reject a mismatched/malformed `Origin` or Fetch Metadata
  `cross-site`, while same-origin browser calls and service/CLI clients without browser headers keep
  working. The API adds no-store, nosniff, frame, referrer and permissions headers. The signed-in
  docs page uses a random per-response nonce CSP; the React app has an explicit CSP and complete
  headers in both Nginx static locations.
- PostgreSQL now binds to `127.0.0.1` like every other published Compose port; forecasting remains
  unpublished. Grafana no longer creates an administrator from a committed fallback password: the
  local synthetic dashboards use anonymous read-only viewing and the already restricted reporting
  database role.
- CI now fails on high-severity Node production dependency advisories and any known forecasting
  production advisory (`pip-audit` is pinned). Both audits are clean as of the review. Focused tests
  cover headers, CSP nonce matching, cross-site denial, allowed proxy/service calls, production
  cookie options, Nginx inheritance, loopback port bindings and the absence of a default Grafana
  administrator.
- Verification: API unit/HTTP **234 → 244**, integration **270**, forecasting **127**, browser e2e
  **5**; formatting, lint, typecheck, both production builds, Compose validation, Node/Python
  dependency audits and all three Docker image builds pass.


### Step 5d — performance verification: rules (written 2026-11-19, BEFORE measuring)

**Where:** the production Docker API (port 3000) on the dev data (200 products × 7 locations,
~349,000 daily demand rows, 1 forecast run of 1,000 series), one laptop (WSL2). Local numbers, not a
benchmark claim. Everything is repeatable with `npm run measure` (extended, below).

**`npm run measure`** is extended, not replaced:
1. *Reads* — every V2 read path is added to the Day-7 list (Control Tower and locations,
   replenishment status, forecast series / explanation, classifications, suppliers, anomalies,
   model registry and monitoring, scenarios, reports, OpenAPI document). 200 sequential requests
   after 10 warm-ups; p50 / p95 / max.
2. *Operations* (`--ops`) — the heavy actions an approver triggers, 5 runs each, median and max:
   generate recommendations, run a scenario, generate a report, recalculate ABC/XYZ. They are run
   on the dev data exactly as a user would (recommendation generation replaces pending ones — that
   is its normal behaviour).
3. *Load* (`--load`) — 20 concurrent signed-in readers for 30 s over a mix of the read paths;
   requests per second, p95, errors.

**Targets, fixed now:**
- simple list / detail reads: **p95 ≤ 100 ms**; aggregate read models (`/overview`,
  `/overview/locations`, `/replenishment/status`, `/ml/monitoring`, `/forecasts/series`): **p95 ≤
  300 ms**;
- operations (median): recommendation generation ≤ 5 s, scenario run ≤ 2 s, report ≤ 2 s,
  ABC/XYZ recalculation ≤ 5 s;
- load: **0 errors**, p95 ≤ 1 s;
- POS simulator (500 sales, 8 at a time, as on Day 7): 0 unexpected errors.

**SQL check:** during the measurement PostgreSQL logs every statement slower than **20 ms**
(`log_min_duration_statement`, set on the database for the run and reset afterwards). Each logged
statement is run again under `EXPLAIN (ANALYZE, BUFFERS)`; a sequential scan of more than 100,000
rows, or a statement over 50 ms, gets an index or a written reason. Anything over its target is
investigated and fixed or reported as found — targets are not changed after measuring.

### Step 5d — performance verification ✅ (2026-11-19)

- `npm run measure` now covers **23 read paths** with their targets (was 7), plus `--ops` (heavy
  operations, 5 runs each) and `--load` (20 concurrent readers, 30 s). Measured against the
  production Docker images rebuilt from the current code, with tracing **off** (the demo had been
  left with Jaeger tracing on after 5b; the default demo has it off).
- **All targets met.** Reads: simple p95 7.5–17 ms (≤ 100); aggregates `/overview` 187 ms,
  `/overview/locations` 44, `/replenishment/status` 18, `/forecasts/series` 12, `/ml/monitoring` 9
  (≤ 300). Operations (median): recommendations 547 ms, scenario 96, report 143, ABC/XYZ 597.
  Load: 190 req/s, p95 237 ms, 0 errors. POS simulator: 500 sales in 2.9 s, 0 unexpected errors.
- **SQL check — one real fix.** With `log_min_duration_statement = 20` (reset afterwards), 1,253
  slow executions of 14 statements were logged. The Control Tower's 28-day sales series ran 479
  times at a median of 150 ms: `EXPLAIN (ANALYZE, BUFFERS)` showed a sequential scan of all 349,084
  demand rows with a hash spilling to disk, because the day range was only implied by the join on
  `generate_series`. Stating the range on `forecast.demand_daily` lets the existing `day` index work:
  **186.8 → 12.7 ms**, identical results (checksums equal). Re-measured: `/overview` p50 129.7 →
  **33.3 ms**, p95 187 → **66 ms**; load **334 req/s**, p95 109 ms, 0 errors.
- **Written reasons for the rest:** ABC/XYZ weekly aggregation (171 ms), its window/label query
  (137 ms), first-sale days (42 ms) and the classification insert (78 ms) read or write a whole year
  for ~1,200 results by design, once a day (total 597 ms, target 5 s). The position query of the
  Control Tower is 26 ms median; its 819 ms maximum occurred only under the 20-client load on a
  laptop sharing CPU with all containers. Recommendation loading (40 ms) and the scenario/report
  queries are under 50 ms.
- Measurement trap found: `docker logs --since` and large `--tail` values returned old or no lines
  on this machine (the Docker VM clock disagrees with WSL); the slow log was read with `--tail 50000`
  and PostgreSQL's own timestamps.
- Tests: API unit 244, integration 270 (Overview tests re-run after the fix: 13 pass), Python 127,
  e2e 5 — unchanged. Docker API, web and forecasting images rebuilt.

### Step 5e — backup, restore and integrity check: rules (written 2026-11-19, BEFORE building)

**Backup** — `npm run db:backup` → `backups/retailpulse-<UTC time>.dump` (PostgreSQL custom format,
compressed, all three schemas) plus `.manifest.json`: source database, server and `pg_dump`
versions, SHA-256 and size of the dump, the last applied migration, and row counts of the key
tables. It uses the host's `pg_dump` when its major version matches the server, otherwise the
`postgres` Compose container's. `backups/` is git-ignored (dumps hold the data and its users).

**Restore** — `npm run db:restore -- <dump> [--target=<new database>]` **only into a new database**:
it refuses when the target exists or is the live database, checks the SHA-256 against the manifest
before touching anything, makes sure the cluster-wide reporting role exists (a database dump does
not contain roles; created `NOLOGIN` exactly as migration 0023 does), restores in one transaction,
then runs the integrity check and compares row counts with the manifest. Switching the application
to the restored database is a manual, documented step (change `DATABASE_URL` / `POSTGRES_DB`).

**Integrity check** — `npm run db:verify [-- --db=<name>] [--json]`, read-only, exit code 1 on any
failure:
1. every balance equals the sum of its ledger rows (on hand and reserved) and its latest
   `on_hand_after` / `reserved_after`; no ledger row without a balance;
2. no negative stock, nothing reserved beyond on hand;
3. outbox: `PROCESSED` ⇔ `processed_at`; consumer receipts only for existing events; events still
   pending or failed after one hour are reported as warnings (not failures — the worker retries);
4. migrations: every file applied, checksums equal to the files, nothing unknown applied.

**Checks:** integration tests run the real CLI against a fresh test database (all pass) and after
deliberately breaking each rule in a transaction-free copy (each named failure, exit code 1);
restore refuses an existing target, the live database and a dump whose checksum does not match.
**Restore drill** on the dev data with measured times for backup, restore and check, row counts equal
to the manifest, and the Control Tower answering identically from the restored database.

### Step 5e — backup, restore and integrity check ✅ (2026-11-19)

- `npm run db:backup` / `db:restore` (`scripts/db/backup.sh`, `restore.sh`, shared `lib.sh`) and
  `npm run db:verify` (`services/api/scripts/verify.mjs`, read-only `REPEATABLE READ READ ONLY`
  transaction, exit 1 on failure). The client tools come from the `postgres` container (no
  PostgreSQL client on this machine); a host `pg_dump` of the same major version is used when present.
  `backups/` is git-ignored.
- **Refusals checked by hand:** restoring onto the live database, onto an existing database, with a
  name that is not a plain identifier (`x; drop database …`), and from a dump with one changed byte
  (SHA-256 mismatch) — all refused with exit code 2 and nothing created.
- **Restore drill on the dev data** (139 MB database): backup **1.3 s** → 5.4 MB dump, manifest with
  passing check; restore into the new database `retailpulse_restore_drill` **3.8 s** (one
  transaction), integrity check **0.2 s** — all 7 checks PASS, row counts equal to the manifest in
  10 tables; 5.7 s end to end. An API pointed at the restored database answered `/overview` and
  `/overview/locations` **byte-identical** to the live demo (KPIs, risks, sales series, 7 locations).
  The Grafana reporting role kept exactly its rights on the restored copy (reporting views yes,
  application tables no, no writes). The drill database was dropped afterwards.
- Found while building: my first backup stopped before the manifest (`pg_dump --version` was given a
  user flag) — fixed, the half backup deleted; `npm run` inside the scripts would have mixed its own
  header lines into the JSON — the check is called directly.
- Tests: integration 270 → **276** (`db-verify.int-spec.ts`: a fresh database passes; a balance
  that disagrees with the ledger, a reservation beyond stock with its constraint temporarily removed,
  a ledger row without a balance, a receipt for a missing event and an edited / unknown migration each
  FAIL by name; an event pending for hours only WARNs; each break is undone and the check passes
  again). API unit 244, Python 127, e2e 5 unchanged. `shellcheck` is not installed here: the shell
  scripts were checked with `bash -n` and exercised end to end, not linted.
- Not done (stated): point-in-time recovery (WAL archiving) and automatic scheduled backups.


### Step 6 — split (decided 2026-11-19)

Collecting every acceptance criterion showed two promises of the testing plan (§6) not kept:
**decision D5** (web component tests with Vitest + Testing Library — the web app has none) and the
**end-to-end 9-step flow** (login → Control Tower → risk → forecast → explanation → recommendation →
approve → transfer → stock updated) plus "a scenario changes nothing" in the browser. So:

- **6-1** close both gaps.
- **6-2** final verification from a fresh install (empty volumes, `npm run demo`), a traceability
  table of every acceptance criterion to its evidence, and the V2 release notes.

### Step 6-1 — closing the test gaps: rules (written 2026-11-19, BEFORE building)

**End-to-end 9-step flow.** The e2e database gets a **fixture forecast** (`e2e/forecast-fixture.mjs`,
run by `start-api.mjs` after the seed): one finished run with a flat, hand-chosen forecast for a few
product × store pairs, the model registry rows and a SHAP explanation for one pair — written exactly
like the integration-test fixtures and labelled as a fixture. The forecasting service itself is not
started (its own suite covers it); the e2e checks what the user sees and does with a forecast:
Control Tower shows the risk → the product's forecast chart and "Why this forecast?" →
Replenishment *Recalculate* → open the recommendation → approve → the created transfer is dispatched
and received → the store's stock went up by exactly the approved quantity (ledger rows visible).
A second test runs a what-if scenario in the browser and proves stock, recommendations and the ledger
are unchanged (counts read through the API before and after).

**Web component tests (D5).** Vitest + Testing Library + jsdom as dev dependencies of `apps/web`,
`npm run test -w apps/web` included in `npm run check`. Tests (behaviour, not snapshots):
role-based visibility (approve buttons, Scenarios menu item, report scope choices for a store
manager), and loading / empty / error states of shared components and one page, with the API client
mocked at the module boundary. Production dependency audits stay clean (dev dependencies only).

### Step 6-1 — closing the test gaps ✅ (2026-11-19)

- **Nine-step e2e flow.** `apps/web/e2e/forecast-fixture.mjs` (run by `start-api.mjs` after the seed)
  writes one finished run labelled "e2e FIXTURE" — a product at STR-01 whose stock lasts under two
  days (DC-NORTH able to cover the order, checked; it fails loudly otherwise), a calm product at
  STR-02, a SHAP explanation and global importance. The new test signs in, takes the first row of the
  Control Tower's "Soonest to run out", opens the product's forecast at STR-01, opens "Why this
  forecast?", presses *Recalculate*, opens the transfer recommendation, approves it, dispatches and
  receives the transfer, and finds STR-01's stock higher by exactly the approved quantity.
- **"A scenario changes nothing" in the browser:** create and run a +50 % scenario, compare it; the
  Control Tower's units on hand and open transfers, the last stock movement and the recommendation
  count are identical before and after (read through the API in the same session).
- The first e2e test asserted "No forecast yet"; with the fixture it now asserts the risk list. The
  old "scenario without a forecast" test became the scenario test above (the no-forecast 409 stays
  covered by the integration tests).
- **D5 done:** Vitest 5 + Testing Library + jsdom (dev dependencies; production audit still 0
  vulnerabilities), `npm run test -w apps/web` inside `npm run check`. 13 tests: Planning → Scenarios
  visible for inventory managers and analysts, not store managers; scenario create / run offered to
  approvers only; report scopes for a store manager (own store only, no network) and an inventory
  manager; loading / empty / error / retry for the shared components and the Scenarios page. The
  network is faked at `fetch` (one level below the API client functions named in the rules) so the
  real client, auth provider and pages run. A mutation check (store managers shown Scenarios) made
  the menu test fail as it should.
- npm reported two older packages with unapproved install scripts (`@parcel/watcher`, `protobufjs`,
  from earlier dependencies) — left as they are, noted for review.
- Tests: web component 0 → **13**, e2e 5 → **6**; API unit 244, integration 276 (no API change),
  Python 127 unchanged. All checks and the production audit pass.

