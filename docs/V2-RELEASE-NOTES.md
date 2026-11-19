# RetailPulse V2 — release notes

Released 2026-11-19. All data is synthetic; every number below is a local measurement on one laptop,
not a claim about real retail. How each item was built and measured: [V2-PLAN §9](V2-PLAN.md#9-progress-log).
Every acceptance criterion with its evidence: [V2-TRACEABILITY.md](V2-TRACEABILITY.md).

V1 (Day 1–7) tracked stock in an append-only ledger, forecast demand and suggested replenishment for
a manager to approve. V2 keeps all of that unchanged and adds the following.

## What's new

**Forecasting you can trust and question**
- **Measured ranges.** 80 % and 95 % ranges from split-conformal calibration, per sales level; on
  the untouched test window they held **80.0 %** and **94.9 %**. The product page states the range in
  words together with its measured reliability.
- **"Why this forecast?"** SHAP contributions per product × store and the model's most relied-on
  inputs. Wording is "contribution to the forecast", never "cause".
- **Honest accuracy.** Bias, per-horizon metrics and range coverage per run. Test WAPE is 51.6 %
  against 54.4 % for the best simple baseline (noise floor 51.0 %). A Random Forest was measured,
  did not earn its place, and was not added.

**Inventory optimisation**
- **ABC/XYZ classification** per product, network-wide and per store, with a policy for each class.
- **Safety stock v2**: forecast error, measured supplier lead-time variability and a service level
  per class.
- **Supplier performance**: lead time, on-time %, reliability score.
- **Replenishment v2**: expected stockout date, moving excess stock between stores (*excess moves*),
  *manual review* for products the model should not decide alone, and "no action required" on the
  product page. A manager still approves every suggestion.

**Unusual activity**
- Sales anomalies (robust z-score; promotions marked as known causes), with measured
  precision/recall on labelled injected anomalies.
- Operational findings: large write-offs, repeated corrections, many returns.
- A review workflow: new → investigating → confirmed / dismissed → resolved, with a note and a
  history. Reviewing never changes stock.

**Model lifecycle**
- **Model registry** in PostgreSQL. A better model becomes *eligible*; a manager activates it or
  rolls back to the previous one, and every change is audited.
- Model files are content-addressed (SHA-256) and checked before loading.
- MLflow is an optional mirror (`mlops` profile).
- **Model monitoring**: data and prediction drift (PSI / KS) and accuracy on newly observed days,
  plus run health. Monitoring never retrains or activates anything.

**Analytics**
- **Control Tower** (the Overview, extended): KPIs, health per location, a risk panel and charts.
  p95 is 66 ms.
- **What-if scenarios** (demand ±%, longer lead times, less DC stock), compared side by side. A test
  proves that running a scenario writes nothing except its own result.
- **Reports**: daily or weekly, network-wide or per store. Each report is frozen when generated and
  available as CSV or a print layout ("Save as PDF").
- **Grafana business dashboards** (Sales, Inventory, Forecast Quality, Suppliers) over read-only
  reporting views.

**Production engineering**
- **OpenAPI 3.1** generated from the runtime Zod schemas, served to signed-in users at
  `/api/v1/docs`. A test fails if any route is missing.
- **OpenTelemetry tracing** API → PostgreSQL → forecasting (optional Jaeger profile). No bodies,
  cookies or credentials are exported.
- **Security review** with a written checklist: [SECURITY-REVIEW.md](SECURITY-REVIEW.md).
- **Performance verified.** Simple reads p95 7.5–17 ms; 334 req/s at p95 109 ms with 0 errors.
- **Backup, restore and integrity check**: `npm run db:backup`, `npm run db:restore` (only ever into
  a new database) and `npm run db:verify`.

## How to run it

From a fresh clone (verified from empty volumes on 2026-11-19; about 3 minutes to a running app):

```bash
cp .env.example .env
```

```bash
docker compose --profile full up --build -d --wait
```

Open http://localhost:8080 and sign in as `inventory@retailpulse.test` with `DEMO_PASSWORD` from
`.env`. Then **Replenishment → Refresh forecasts** (about a minute) and start at the **Control Tower**.

## How data gets in

- **Seed** (automatic in Docker): 5 stores, 2 DCs, 200 products, 3 suppliers, 5 demo accounts,
  synthetic supplier delivery history.
- **Synthetic sales history** (automatic in Docker, `npm run forecast:history` locally): 12 months
  per product × store, with a promotion calendar and labelled injected anomalies.
- **Forecasts and recommendations**: *Refresh forecasts* / *Recalculate* in the app.
- **Shop traffic and unusual activity through the API**: `npm install && npm run demo` (POS sales,
  write-offs, corrections, returns, a forecast, recommendations, ABC/XYZ).
- **People in the UI**: approvals, transfers, receipts, anomaly reviews, scenarios, reports, model
  activation.

## Verification of this release

On a clean clone of `48bef2d` with new empty volumes, following only the README:
- build and start: 135 s + 49 s; the forecast refresh took 53 s; `npm run demo` exited 0;
- `npm run db:verify`: all 7 checks pass;
- every page at 1280 and 390 px: no console error and no horizontal scroll; a store manager sees
  only their store;
- one defect found and fixed: restarting the full demo on a database that already had real sales
  failed (the regenerated synthetic history collided with them); real sales now win and are kept;
- tests: 244 API unit/HTTP · 13 web component · 276 integration · 128 Python · 6 end-to-end, all
  pass.

## Known limitations

- **Synthetic data only.** Accuracy says nothing about real demand, and demand is not corrected for
  stockouts. Anomaly precision is low for small spikes (a base-rate limit, explained on the page);
  HIGH findings come first.
- **Local demo, not a deployment.** There is no TLS proxy or HSTS; the login rate limit is held in
  memory; Grafana allows anonymous read-only viewing on localhost. See the security review.
- **Backups are logical dumps.** There is no point-in-time recovery and no scheduled backup.
- **Not built:** manual purchase orders, partial transfer deliveries, Superset, hosting.
- On a fresh install, monitoring honestly reports "not enough data" until 7 complete days have
  passed after training.
