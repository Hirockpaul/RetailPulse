# RetailPulse V2 — Phase 0 audit and implementation plan

Status: decisions D1, D2, D4 confirmed; built one step at a time (§0). **Steps 1a–1c built** (see §9);
waiting for approval of step 1d.
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

### Step 1c — explanations (SHAP) ✅ (2026-11-17, not committed yet)

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

