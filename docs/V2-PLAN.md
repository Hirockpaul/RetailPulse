# RetailPulse V2 — Phase 0 audit and implementation plan

Status: decisions D1, D2, D4 confirmed; built one step at a time (§0). **Phases 1 and 2 and
Phase 3 and step 4a (Control Tower) are built** (see §9); next is 4b, what-if scenarios.
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

