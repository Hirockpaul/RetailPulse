// A hand-written FORECAST FIXTURE for the end-to-end tests (V2 6-1). The forecasting service is not
// started in e2e (its own Python suite covers it); this writes one finished run straight into the
// forecast schema, exactly like the API integration-test fixtures, so the browser can walk the
// forecast → explanation → recommendation → transfer flow. Labelled as a fixture in the run itself.
//
// It picks, deterministically, one product at STR-01 that will need stock from DC-NORTH:
//   perDay = ceil(available / 1.5) + 5   → stock lasts under 2 days: below the reorder point, at risk
//   DC-NORTH must hold ≥ 12 × perDay      → the recommendation is a transfer the DC can cover
// and one well-stocked product at STR-02 that needs nothing. Products used by other e2e tests
// (RP-00001, RP-00002) are left alone.
import pg from 'pg';

const AVOID = ['RP-00001', 'RP-00002'];

export async function seedForecastFixture(databaseUrl) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const loc = Object.fromEntries(
      (
        await db.query(
          `SELECT code::text, id FROM locations WHERE code IN ('STR-01', 'STR-02', 'DC-NORTH')`,
        )
      ).rows.map((r) => [r.code, r.id]),
    );
    const needy = (
      await db.query(
        `SELECT p.id, p.sku::text AS sku, (s.on_hand - s.reserved) AS available,
                (d.on_hand - d.reserved) AS dc
           FROM products p
           JOIN inventory_balances s ON s.product_id = p.id AND s.location_id = $1
           JOIN inventory_balances d ON d.product_id = p.id AND d.location_id = $2
          WHERE p.is_active AND p.sku::text <> ALL($3) AND s.on_hand - s.reserved > 0
            AND (d.on_hand - d.reserved) >= 12 * (ceil((s.on_hand - s.reserved) / 1.5) + 5)
          ORDER BY p.sku LIMIT 1`,
        [loc['STR-01'], loc['DC-NORTH'], AVOID],
      )
    ).rows[0];
    if (!needy) throw new Error('Forecast fixture: no product at STR-01 that DC-NORTH can cover.');
    const calm = (
      await db.query(
        `SELECT p.id, p.sku::text AS sku FROM products p
           JOIN inventory_balances s ON s.product_id = p.id AND s.location_id = $1
          WHERE p.is_active AND p.sku::text <> ALL($2) AND p.id <> $3 AND s.on_hand - s.reserved >= 40
          ORDER BY p.sku LIMIT 1`,
        [loc['STR-02'], AVOID, needy.id],
      )
    ).rows[0];
    const perDay = Math.ceil(needy.available / 1.5) + 5;
    const pairs = [
      { product: needy.id, location: loc['STR-01'], perDay },
      { product: calm.id, location: loc['STR-02'], perDay: 1 },
    ];

    const model = (
      await db.query(
        `INSERT INTO forecast.model_versions (name, version, kind, description)
         VALUES ('hgb_direct', 'e2e-fixture', 'ML', 'e2e fixture model (no artifact)')
         ON CONFLICT (name, version) DO UPDATE SET description = EXCLUDED.description
         RETURNING id`,
      )
    ).rows[0].id;
    const runId = (
      await db.query(
        `INSERT INTO forecast.runs (status, finished_at, horizon_days, data_label, history_start,
            history_end, train_end, validation_start, validation_end, test_start, test_end,
            series_count, fallback_count, served_model_version_id, selection_reason,
            ml_beat_baseline, feature_set, explanation_status)
         VALUES ('SUCCEEDED', now(), 14, 'SYNTHETIC', current_date - 300, current_date - 1,
                 current_date - 1, current_date - 56, current_date - 29, current_date - 28,
                 current_date - 1, $1, 0, $2,
                 'e2e FIXTURE: hand-written forecast; the forecasting service is not started in e2e',
                 true, ARRAY['mean_56d'], 'OK')
         RETURNING id`,
        [pairs.length, model],
      )
    ).rows[0].id;

    for (const p of pairs) {
      await db.query(
        `INSERT INTO forecast.series (run_id, product_id, location_id, history_days, model,
            is_fallback, avg_daily_28, std_daily_90, sigma, test_wape)
         VALUES ($1, $2, $3, 300, 'hgb_direct', false, $4, 2, 2, 0.3)`,
        [runId, p.product, p.location, p.perDay],
      );
      await db.query(
        `INSERT INTO forecast.points (run_id, product_id, location_id, target_day, horizon_day, yhat,
            lower, upper, lower95, upper95)
         SELECT $1, $2, $3, current_date + h, h, $4::numeric, greatest($4::numeric - 2, 0),
                $4::numeric + 2, greatest($4::numeric - 4, 0), $4::numeric + 4
           FROM generate_series(1, 14) h`,
        [runId, p.product, p.location, p.perDay],
      );
      // 56 days of history around the same level, with a weekly pattern, for the chart.
      await db.query(
        `INSERT INTO forecast.demand_daily (product_id, location_id, day, units, source)
         SELECT $1, $2, current_date - d, greatest(round($3::numeric * (1 + 0.2 * sin(d))), 0), 'SYNTHETIC'
           FROM generate_series(1, 56) d
         ON CONFLICT DO NOTHING`,
        [p.product, p.location, p.perDay],
      );
    }
    // "Why this forecast?" for the needy pair: starting point × 1.5 (recent sales) = the forecast.
    await db.query(
      `INSERT INTO forecast.explanations (run_id, product_id, location_id, horizon_day, base_log,
          forecast, contributions) VALUES ($1, $2, $3, 1, $4, $5, $6)`,
      [
        runId,
        needy.id,
        loc['STR-01'],
        Math.log(perDay / 1.5),
        perDay,
        JSON.stringify([
          { feature: 'mean_56d', value: perDay, contribution: Math.log(1.5) },
          { feature: 'weekday', value: 2, contribution: 0 },
        ]),
      ],
    );
    await db.query(
      `INSERT INTO forecast.feature_importance (run_id, feature, mean_abs_contribution, rank)
       VALUES ($1, 'mean_56d', 0.4, 1), ($1, 'weekday', 0.1, 2)`,
      [runId],
    );
    console.log(
      `e2e forecast fixture: ${needy.sku} at STR-01 (${needy.available} available, ${perDay}/day, ` +
        `DC-NORTH ${needy.dc}); ${calm.sku} at STR-02 (1/day).`,
    );
    return { needySku: needy.sku, calmSku: calm.sku, perDay };
  } finally {
    await db.end();
  }
}
