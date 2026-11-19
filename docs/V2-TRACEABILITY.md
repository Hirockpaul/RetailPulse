# RetailPulse V2 — acceptance criteria → evidence

Every acceptance criterion of [V2-PLAN §3](V2-PLAN.md#3-phased-plan-with-acceptance-criteria), every
item of its testing plan (§6) and every decision (§2), with the evidence that it holds. "§9 *step*"
points to that step's entry in the V2-PLAN progress log, where the measurement is described.
All data is synthetic; numbers are local measurements, not claims about real retail.

Status: **Met** · **Met differently** (what differs and why) · **Not done**.
Checked last on 2026-11-19 from a fresh install of commit `48bef2d` (step 6-2, at the end).

## Phase 1 — ML intelligence

| # | Criterion | Evidence | Status |
|---|---|---|---|
| 1a | Leakage tests still green | `services/forecasting/tests/test_backtest.py` (`…using_only_earlier_origins`), `test_ml.py` (`…only_past_promotions`) — 128/128 Python tests pass | Met |
| 1a | New metrics (bias, per-horizon, coverage, width) persisted per run | migration `0007_forecast_foundation.sql` (`forecast.horizon_metrics`; `bias`, `interval_coverage`, `interval_width` on `model_metrics`); `test_db_pipeline.py` | Met |
| 1a | ARCHITECTURE §7.3 re-measured, old and new side by side, with the noise floor | ARCHITECTURE §7.3; §9 1a: test WAPE 51.6 % (Day 6 model 52.2 %, best baseline 54.4 %, noise floor 51.0 %) | Met |
| 1b | Measured coverage within ±5 points of nominal on the test window | §9 1b: 80 % range held **80.0 %**, 95 % held **94.9 %**; every level group 78.5–84.2 % / 93.8–95.7 %; `test_intervals.py` | Met |
| 1b | Compared with the previous band | §9 1b: old ±1.28 σ band 83.4 % overall, 91 % slow / 78 % fast sellers; `test_a_symmetric_normal_band_would_mis_cover_slow_and_fast_sellers` | Met |
| 1c | SHAP additivity (Σ contributions + base = model output, 1e-6) | `test_explain.py::test_contributions_add_up_exactly_to_the_models_forecast` (measured error ~1e-15); non-additive results are not stored (`test_wrong_explanations_are_refused_not_stored`) | Met |
| 1c | Explanation endpoint + "Why this forecast?" panel | `GET /forecasts/explanation` (`forecasts.explain.spec.ts`, replenishment integration tests); e2e "the nine steps…" opens the panel | Met |
| 1d | Comparison table: MAE, RMSE, WAPE, bias, coverage per model and split | `app/evaluation/compare.py`, `test_compare.py`; §9 1d: Random Forest 51.4 / 52.1 % vs production 50.9 / 51.6 % → **not added** | Met |
| 1e | Measured precision/recall on injected anomalies | §9 1e-1 (held-out seed 99): spikes 4.2 % / 83.6 %, HIGH spikes 47.4 % / 13.4 %, drops 19.7 % / 92.3 %; `test_anomalies.py::test_detection_finds_most_injected_spikes_on_labelled_synthetic_data` | Met |
| 1e | Nothing touches stock | `anomalies.int-spec.ts` "reviewing never changes stock" | Met |
| 1e | Store managers see only their stores | `anomalies.int-spec.ts` "…to every role, store-scoped", "only people who may act on that store can review"; fresh-install check: store1 sees only STR-01 | Met |
| 1e | Anomalies page with review workflow; e2e covers one review | *Unusual activity* page + detail; e2e "a large write-off becomes a finding that a manager can investigate" | Met |

## Phase 2 — Inventory optimization

| Criterion | Evidence | Status |
|---|---|---|
| Pure-function unit tests with hand-checked numbers for every formula | ABC/XYZ `classifications.calc.spec.ts` (9 tests); safety stock v2 / stockout date / redistribution `replenishment.calc.spec.ts` (e.g. "uses L = promise + delay … (checked by hand)"); supplier reliability `suppliers.score.spec.ts` | Met |
| Approval still required | `replenishment.int-spec.ts` "only admins and inventory managers can generate, approve or reject", "approving a transfer recommendation creates an APPROVED transfer, and moves no stock yet" | Met |
| 5 concurrent approvals still create one document | `replenishment.int-spec.ts` "five simultaneous approvals create exactly one document" and the 2d-1 flagged-recommendation variant | Met |
| Supplier statistics from synthetic PO history | §9 2c: measured on-time 89.7 / 75.7 / 52.8 % vs profiles 90 / 75 / 50 %; `suppliers.int-spec.ts` | Met |

## Phase 3 — ML lifecycle

| Criterion | Evidence | Status |
|---|---|---|
| Rollback restores the previous artifact, tested | `ml-registry.int-spec.ts` "rolls back only to the immediately previous active model and history is immutable"; `test_artifacts.py` (content-addressed, tamper rejected before loading) | Met |
| Drift tests with synthetic shifted data | `test_monitoring.py`: unshifted control STABLE, network-wide shift DRIFT, one-store shift caught per store; §9 3c-1 | Met |
| Model Monitoring page | `#/monitoring` (run health, drift, accuracy on new days); opened on the fresh install | Met |
| No automatic retraining | §9 3c-1 (monitoring never retrains or activates — tested); activation is a manager action (D4) | Met |

## Phase 4 — Analytics

| Criterion | Evidence | Status |
|---|---|---|
| Running scenarios changes no row in ledger, balances, outbox, transfers or POs | `scenarios.int-spec.ts` "running scenarios writes nothing but its result…" (row counts + checksums); e2e "a what-if scenario runs in the browser and changes no stock, ledger or recommendation" | Met |
| Reports show period + generated-at | `reports.int-spec.ts`; e2e "a manager generates a report, sees its period and generation time, and can print it" | Met |
| Control Tower p95 measured | §9 4a-1: p95 122.5 ms (target ≤ 300); after the 5d query fix p95 **66 ms** (README *Measured numbers*); `overview.int-spec.ts` "reading the Control Tower writes nothing" | Met |
| BI per D1 | Grafana *Sales / Inventory / Forecast Quality / Suppliers* over read-only `reporting` views; `business-intelligence.int-spec.ts` (role has views only, no writes) | Met |

## Phase 5 — Production engineering

| Criterion | Evidence | Status |
|---|---|---|
| Route-coverage test for OpenAPI | `services/api/test/app.spec.ts` "covers every real Nest route exactly once and has unique operation ids"; e2e "a signed-in analyst can read the generated API contract" | Met |
| Restore drill documented with measured timings | §9 5e and README *Backup and restore*: backup 1.3 s, restore into a new database 3.8 s, integrity check 0.2 s; `db-verify.int-spec.ts` | Met |
| OpenTelemetry, no bodies / cookies / credentials in spans | `tracing.spec.ts`, `test_tracing.py`; §9 5b | Met |
| Security review with a written checklist | [SECURITY-REVIEW.md](SECURITY-REVIEW.md); `security-config.spec.ts`, `authorization.int-spec.ts`; production audits clean (§9 5c) | Met |
| Performance numbers recorded | §9 5d; README *Measured numbers* (all targets met; load 334 req/s, p95 109 ms, 0 errors) | Met |

## Testing plan (§6)

| Item | Evidence | Status |
|---|---|---|
| Python: leakage, conformal coverage, SHAP additivity, anomaly precision/recall, drift on shifted data, registry/rollback, write guard | `test_backtest.py`, `test_ml.py`, `test_intervals.py`, `test_explain.py`, `test_anomalies.py`, `test_monitoring.py`, `test_registry.py`, `test_artifacts.py`, `test_write_guard.py` (128 tests) | Met |
| API: pure-function tests for ABC/XYZ, safety stock, scenarios | `classifications.calc.spec.ts`, `replenishment.calc.spec.ts`, `replenishment.scenario.spec.ts` (244 unit/HTTP tests) | Met |
| API: integration per endpoint (auth, store scope, validation, "writes nothing" for scenarios / overview / reports) | 19 integration suites, 276 tests; "writes nothing" in `scenarios`, `overview`, `reports` int-specs | Met |
| Web: Vitest + Testing Library for role visibility and loading / empty / error states | `apps/web/src/test/roles.test.tsx`, `states.test.tsx` (13 tests) | Met |
| E2E: the 9-step flow + "scenario changes nothing" | `apps/web/e2e/happy-path.spec.ts` (6 tests) | Met differently: the forecast in the e2e database is a labelled fixture (`e2e/forecast-fixture.mjs`); the forecasting service is not started in e2e — its own 128 tests cover it, and the fresh install ran it for real |
| Every phase ends with all four checks and measured numbers in the README | each §9 entry lists its test counts; README *Measured numbers* | Met |

## Decisions (§2)

| # | Decision | Evidence | Status |
|---|---|---|---|
| D1 | Grafana + SQL views, no Superset | §9 4d | Met |
| D2 | Own drift code (KS + PSI, SciPy), no Evidently | `app/monitoring/drift.py`, `test_monitoring.py` | Met |
| D3 | MLflow optional, mirror only; app works without it | `mlops` profile, `mlflow_mirror.py`; §9 3b; the fresh install ran without MLflow | Met |
| D4 | Manager-activated models | §9 3a; `ml-registry.int-spec.ts` | Met |
| D5 | Vitest + Testing Library in `apps/web` | §9 6-1 | Met |
| D6 | Supplier lead time: statistics only, no ML | §9 2c | Met |
| D7 | Print stylesheet + server CSV, no PDF service | §9 4c-2; `reports.csv.spec.ts` | Met |

## Final check — fresh install (step 6-2)

A clean clone of `48bef2d`, new empty Docker volumes, the README steps only:

| Check | Result |
|---|---|
| `docker compose --profile full build --no-cache` / `up -d --wait` | exit 0; **135 s** build, **49 s** to all services healthy (migrate, seed, 12 months of synthetic history) |
| *Replenishment → Refresh forecasts* in the browser | **53 s**; 261 recommendations from 1,000 products |
| `npm install && npm run demo` | exit 0; 34 s + 59 s (200 POS sales, unusual activity, forecast, 281 recommendations, ABC/XYZ) |
| `npm run db:verify` | all 7 checks PASS (1,400 balances = ledger, 24/24 migrations) |
| Every page as inventory manager at 1280 and 390 px (15 pages + 5 detail pages) | no console error, no failed request, no horizontal scroll; store1 sees only STR-01 |
| `npm run check` · `test:int` · `forecast:test` · `test:e2e` | 244 + 13 · 276 · 127 · 6 — all pass |
| Restart on an existing database (`down`, then `up` — found afterwards, see below) | failed at `48bef2d` (synthetic history collided with real sales); fixed in 6-2, now exit 0 with real sales kept; Python tests 127 → 128 |

The restart failure is the one defect 6-2 found: an empty database cannot show it, so it surfaced
only when the dev stack was started again on its own data. Fix and test: §9 6-2.

## Not done (stated, not part of any criterion)

- Point-in-time recovery (WAL archiving) and scheduled automatic backups (§9 5e).
- Production edge (TLS proxy, HSTS, shared rate-limit storage) — see [SECURITY-REVIEW.md](SECURITY-REVIEW.md).
- Manual purchase orders, partial transfer deliveries, hosting (README *Known limitations*).
